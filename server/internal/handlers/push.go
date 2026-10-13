package handlers

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"familycall/server/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/SherClockHolmes/webpush-go"
	"gorm.io/gorm"
	"io"
)

type PushSubscribeKeys struct {
	P256DH string `json:"p256dh" binding:"required"`
	Auth   string `json:"auth" binding:"required"`
}

type PushSubscribeRequest struct {
	Endpoint string            `json:"endpoint" binding:"required"`
	Keys     PushSubscribeKeys `json:"keys" binding:"required"`
}

func (h *Handlers) GetVAPIDPublicKey(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"publicKey": h.config.VAPIDKeys.PublicKey,
	})
}

func (h *Handlers) SubscribePush(c *gin.Context) {
	userID, _ := c.Get("user_id")
	userIDStr := userID.(string)

	log.Printf("[PUSH] Subscribe request from user %s", userIDStr)

	var req PushSubscribeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[PUSH] Invalid subscribe request from user %s: %v", userIDStr, err)
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	log.Printf("[PUSH] Subscription endpoint: %s", req.Endpoint[:min(100, len(req.Endpoint))])
	log.Printf("[PUSH] P256DH key length: %d, Auth key length: %d", len(req.Keys.P256DH), len(req.Keys.Auth))

	// Delete all existing subscriptions for this user (keep only the latest one)
	result := h.db.Where("user_id = ?", userIDStr).Delete(&models.PushSubscription{})
	deletedCount := result.RowsAffected
	if result.Error != nil {
		log.Printf("[PUSH] Error deleting old subscriptions for user %s: %v", userIDStr, result.Error)
		// Continue anyway - try to create new subscription
	} else if deletedCount > 0 {
		log.Printf("[PUSH] Deleted %d old subscription(s) for user %s", deletedCount, userIDStr)
	}

	// Create new subscription
	subscription := models.PushSubscription{
		UserID:   userIDStr,
		Endpoint: req.Endpoint,
		P256DH:   req.Keys.P256DH,
		Auth:     req.Keys.Auth,
	}

	if err := h.db.Create(&subscription).Error; err != nil {
		log.Printf("[PUSH] Error creating subscription for user %s: %v", userIDStr, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create subscription"})
		return
	}

	log.Printf("[PUSH] Created new subscription for user %s (ID: %s, replaced %d old ones)", userIDStr, subscription.ID, deletedCount)
	
	// Verify it was saved
	var verifySub models.PushSubscription
	if err := h.db.Where("user_id = ?", userIDStr).First(&verifySub).Error; err != nil {
		log.Printf("[PUSH] WARNING: Could not verify subscription was saved for user %s: %v", userIDStr, err)
	} else {
		log.Printf("[PUSH] Verified subscription saved: user_id=%s, endpoint=%s", verifySub.UserID, verifySub.Endpoint[:min(50, len(verifySub.Endpoint))])
	}
	
	c.JSON(http.StatusCreated, subscription)
}

func (h *Handlers) UnsubscribePush(c *gin.Context) {
	userID, _ := c.Get("user_id")

	var req struct {
		Endpoint string `json:"endpoint" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var subscription models.PushSubscription
	if err := h.db.Where("user_id = ? AND endpoint = ?", userID, req.Endpoint).First(&subscription).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Subscription not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	if err := h.db.Delete(&subscription).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete subscription"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Unsubscribed"})
}

// SendPushNotification sends a push notification to a user
func (h *Handlers) SendPushNotification(userID string, title string, body string, data map[string]interface{}) error {
	log.Printf("[PUSH] Sending push notification to user %s: %s - %s", userID, title, body)
	
	var subscriptions []models.PushSubscription
	if err := h.db.Where("user_id = ?", userID).Find(&subscriptions).Error; err != nil {
		log.Printf("[PUSH] Error querying subscriptions for user %s: %v", userID, err)
		return err
	}

	// Debug: Check all subscriptions to see what user_ids exist
	var allSubs []models.PushSubscription
	h.db.Find(&allSubs)
	log.Printf("[PUSH] Debug: Total subscriptions in DB: %d", len(allSubs))
	for i, sub := range allSubs {
		log.Printf("[PUSH] Debug: Subscription %d - user_id: %s, endpoint: %s", i+1, sub.UserID, sub.Endpoint[:min(50, len(sub.Endpoint))])
	}

	if len(subscriptions) == 0 {
		log.Printf("[PUSH] No push subscriptions found for user %s", userID)
		return nil
	}

	log.Printf("[PUSH] Found %d subscription(s) for user %s", len(subscriptions), userID)

	payload := map[string]interface{}{
		"title":    title,
		"body":     body,
		"data":     data,
		"priority": "high", // High priority to ensure notification is shown
		"urgency":  "high", // Web Push API urgency level
	}

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[PUSH] Error marshaling payload: %v", err)
		return err
	}

	successCount := 0
	failCount := 0

	for i, sub := range subscriptions {
		log.Printf("[PUSH] Sending to subscription %d/%d: endpoint=%s", i+1, len(subscriptions), sub.Endpoint)
		
		// Validate subscription keys before attempting to send
		if sub.P256DH == "" || sub.Auth == "" {
			log.Printf("[PUSH] Skipping subscription %d: missing keys (P256DH or Auth empty)", i+1)
			failCount++
			// Delete invalid subscription
			h.db.Delete(&sub)
			continue
		}
		
		// Trim whitespace
		p256dhKey := strings.TrimSpace(sub.P256DH)
		authKey := strings.TrimSpace(sub.Auth)
		
		// The webpush-go library's decodeSubscriptionKey handles both standard and URL-safe base64
		// It adds padding if needed and tries both encodings
		// So we can pass the keys directly as stored
		// But let's validate they decode correctly first
		var p256dhBytes []byte
		var authBytes []byte
		var err error
		
		// Try URL-safe base64 first (what frontend sends)
		p256dhBytes, err = base64.RawURLEncoding.DecodeString(p256dhKey)
		if err != nil {
			// Try with padding
			if rem := len(p256dhKey) % 4; rem != 0 {
				padded := p256dhKey + strings.Repeat("=", 4-rem)
				p256dhBytes, err = base64.RawURLEncoding.DecodeString(padded)
			}
			if err != nil {
				// Try standard base64
				p256dhBytes, err = base64.StdEncoding.DecodeString(p256dhKey)
				if err != nil {
					log.Printf("[PUSH] Cannot decode P256DH key for subscription %d: %v", i+1, err)
					log.Printf("[PUSH] P256DH key (first 30 chars): %s", p256dhKey[:min(30, len(p256dhKey))])
					failCount++
					h.db.Delete(&sub)
					continue
				}
			}
		}
		
		authBytes, err = base64.RawURLEncoding.DecodeString(authKey)
		if err != nil {
			// Try with padding
			if rem := len(authKey) % 4; rem != 0 {
				padded := authKey + strings.Repeat("=", 4-rem)
				authBytes, err = base64.RawURLEncoding.DecodeString(padded)
			}
			if err != nil {
				// Try standard base64
				authBytes, err = base64.StdEncoding.DecodeString(authKey)
				if err != nil {
					log.Printf("[PUSH] Cannot decode Auth key for subscription %d: %v", i+1, err)
					log.Printf("[PUSH] Auth key (first 30 chars): %s", authKey[:min(30, len(authKey))])
					failCount++
					h.db.Delete(&sub)
					continue
				}
			}
		}
		
		// Validate key lengths - these are critical
		if len(p256dhBytes) != 65 {
			log.Printf("[PUSH] Invalid P256DH key length: %d bytes (expected 65) for subscription %d - deleting", len(p256dhBytes), i+1)
			failCount++
			h.db.Delete(&sub)
			continue
		}
		
		// Validate P256DH key format: should start with 0x04 (uncompressed point)
		if p256dhBytes[0] != 0x04 {
			log.Printf("[PUSH] Invalid P256DH key format: first byte is 0x%02x (expected 0x04) for subscription %d - deleting", p256dhBytes[0], i+1)
			failCount++
			h.db.Delete(&sub)
			continue
		}
		
		if len(authBytes) != 16 {
			log.Printf("[PUSH] Invalid Auth key length: %d bytes (expected 16) for subscription %d - deleting", len(authBytes), i+1)
			failCount++
			h.db.Delete(&sub)
			continue
		}
		
		// Log key details for debugging
		log.Printf("[PUSH] Valid keys - P256DH: %d bytes (format: 0x%02x...), Auth: %d bytes", 
			len(p256dhBytes), p256dhBytes[0], len(authBytes))
		
		// Log VAPID key info
		vapidPrivateDecoded, _ := base64.RawURLEncoding.DecodeString(h.config.VAPIDKeys.PrivateKey)
		log.Printf("[PUSH] VAPID private key length: %d bytes (expected 32)", len(vapidPrivateDecoded))
		
		subscription := &webpush.Subscription{
			Endpoint: sub.Endpoint,
			Keys: webpush.Keys{
				P256dh: p256dhKey, // Use original stored key
				Auth:   authKey,   // Use original stored key
			},
		}

		resp, err := webpush.SendNotification(payloadBytes, subscription, &webpush.Options{
			Subscriber:      h.config.VAPIDKeys.Subject,
			VAPIDPublicKey:  h.config.VAPIDKeys.PublicKey,
			VAPIDPrivateKey: h.config.VAPIDKeys.PrivateKey,
			TTL:             30,
		})

		if err != nil {
			log.Printf("[PUSH] Error sending notification to subscription %d: %v", i+1, err)
			log.Printf("[PUSH] Subscription details: endpoint=%s, P256DH length=%d, Auth length=%d", 
				sub.Endpoint, len(sub.P256DH), len(sub.Auth))
			failCount++
			
			// If it's a key-related error, delete the invalid subscription
			if strings.Contains(err.Error(), "modulus") || strings.Contains(err.Error(), "key") || strings.Contains(err.Error(), "overflow") {
				log.Printf("[PUSH] Deleting invalid subscription %d due to key error: %v", i+1, err)
				h.db.Delete(&sub)
			}
			continue
		}
		
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		    log.Printf(
			"[PUSH] Notification %d rejected: HTTP %d, body=%q, readErr=%v",
			i+1,
			resp.StatusCode,
			string(body),
			readErr,
		    )

		    failCount++

		    if resp.StatusCode == 404 || resp.StatusCode == 410 {
			log.Printf("[PUSH] Deleting expired subscription %d", i+1)
			h.db.Delete(&sub)
		    }

		    continue
		}

		log.Printf(
		    "[PUSH] Notification %d accepted: HTTP %d",
		    i+1,
		    resp.StatusCode,
		)
		successCount++
	}

	log.Printf("[PUSH] Push notification summary for user %s: %d succeeded, %d failed", userID, successCount, failCount)
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (h *Handlers) GetTURNConfig(c *gin.Context) {
	// Get TURN server configuration - use only our TURN server
	// TURN servers also support STUN, so we don't need separate STUN servers
	// Note: We use "turn:" (not "turns:") because our TURN server is UDP-only
	// TURNS (TLS) requires TCP/TLS, but we're using UDP which doesn't support TLS
	// Media encryption is handled by DTLS-SRTP in WebRTC
	
	host := c.Request.Host
	if idx := strings.Index(host, ":"); idx != -1 {
		host = host[:idx]
	}
	
	// Get credentials from TURN server
	creds := h.turnServer.GetCredentials()
	
	// TURN server URL - format: turn:host:port
	// Also include STUN URL (TURN servers support STUN protocol)
	turnURL := fmt.Sprintf("turn:%s:%d", host, h.config.TURNPort)
	stunURL := fmt.Sprintf("stun:%s:%d", host, h.config.TURNPort)
	
	iceServers := []map[string]interface{}{
		{
			"urls": stunURL,
		},
		{
			"urls":       turnURL,
			"username":   creds.Username,
			"credential": creds.Password,
		},
	}
	
	log.Printf("TURN config requested - returning %d ICE servers for host %s", len(iceServers), host)
	
	c.JSON(http.StatusOK, gin.H{
		"iceServers": iceServers,
	})
}

