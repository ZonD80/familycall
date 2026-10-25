package websocket

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Hub maintains the set of active clients and broadcasts messages to clients
type Hub struct {
	// Registered clients
	clients map[string]*Client
	clientsMutex sync.RWMutex

	// Register requests from clients
	Register chan *Client

	// Unregister requests from clients
	Unregister chan *Client

	// Inbound messages from clients
	Broadcast chan []byte

	// Pending call requests for offline users (userID -> []pendingCall)
	pendingCalls map[string][]pendingCall

	// Clock, overridable in tests
	now func() time.Time
}

// PendingCallTTL is how long a call-request for an offline user stays valid.
// It should outlive the caller's ring timeout so the call can still be answered.
const PendingCallTTL = 60 * time.Second

type pendingCall struct {
	msg      Message
	storedAt time.Time
}

// Message represents a WebRTC signaling message
type Message struct {
	Type      string      `json:"type"`      // "offer", "answer", "ice-candidate", "call-request", "call-accept", "call-reject"
	From      string      `json:"from"`      // User ID of sender
	To        string      `json:"to"`        // User ID of recipient
	CallType  string      `json:"call_type"` // "audio" or "video"
	Data      interface{} `json:"data"`      // WebRTC offer/answer/ICE candidate data
}

func NewHub() *Hub {
	return &Hub{
		clients:      make(map[string]*Client),
		Register:     make(chan *Client),
		Unregister:   make(chan *Client),
		Broadcast:    make(chan []byte),
		pendingCalls: make(map[string][]pendingCall),
		now:          time.Now,
	}
}

func getClientIDs(clients map[string]*Client) []string {
	ids := make([]string, 0, len(clients))
	for id := range clients {
		ids = append(ids, id)
	}
	return ids
}

// IsUserOnline checks if a user is online (within 10 seconds of last activity)
func (h *Hub) IsUserOnline(userID string) bool {
	h.clientsMutex.RLock()
	defer h.clientsMutex.RUnlock()
	
	client, ok := h.clients[userID]
	if !ok {
		return false
	}
	
	// Check if last activity was within 10 seconds
	return time.Since(client.LastActivity) < 10*time.Second
}

// GetOnlineUsers returns a map of user IDs that are currently online
func (h *Hub) GetOnlineUsers() map[string]bool {
	h.clientsMutex.RLock()
	defer h.clientsMutex.RUnlock()
	
	online := make(map[string]bool)
	now := time.Now()
	for userID, client := range h.clients {
		if now.Sub(client.LastActivity) < 10*time.Second {
			online[userID] = true
		}
	}
	return online
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.Register:
			h.clientsMutex.Lock()
			h.clients[client.UserID] = client
			// Update LastActivity immediately on registration
			client.LastActivity = time.Now()
			h.clientsMutex.Unlock()
			log.Printf("Client registered: %s (total clients: %d)", client.UserID, len(h.clients))
			
			// Broadcast user-online message to all other connected users
			// Do this BEFORE checking pending calls so online status is set immediately
			h.clientsMutex.RLock()
			onlineMsg := Message{
				Type: "user-online",
				From: client.UserID,
				To:   "", // Empty To means broadcast to all
			}
			onlineMsgBytes, _ := EncodeMessage(onlineMsg)
			for userID, otherClient := range h.clients {
				if userID != client.UserID {
					select {
					case otherClient.Send <- onlineMsgBytes:
						log.Printf("Notified %s that %s is now online", userID, client.UserID)
					default:
						// Send buffer full, skip
					}
				}
			}
			h.clientsMutex.RUnlock()
			
			// Check for pending calls and resend the ones that haven't expired
			if pendingCalls, ok := h.pendingCalls[client.UserID]; ok && len(pendingCalls) > 0 {
				log.Printf("Resending %d pending call(s) to user %s", len(pendingCalls), client.UserID)
				for _, pending := range pendingCalls {
					if h.now().Sub(pending.storedAt) > PendingCallTTL {
						log.Printf("Dropping expired pending call-request from %s to %s", pending.msg.From, client.UserID)
						continue
					}
					messageBytes, err := EncodeMessage(pending.msg)
					if err == nil {
						select {
						case client.Send <- messageBytes:
							log.Printf("Resent pending call-request to %s", client.UserID)
						default:
							log.Printf("Failed to resend pending call-request to %s (send buffer full)", client.UserID)
						}
					}
				}
				// Clear pending calls after resending
				delete(h.pendingCalls, client.UserID)
			}

		case client := <-h.Unregister:
			h.clientsMutex.Lock()
			wasRegistered := false
			if _, ok := h.clients[client.UserID]; ok {
				wasRegistered = true
				delete(h.clients, client.UserID)
				close(client.Send)
				log.Printf("Client unregistered: %s (remaining clients: %d)", client.UserID, len(h.clients))
			}
			h.clientsMutex.Unlock()
			
			// Broadcast user-offline message to all other connected users
			if wasRegistered {
				h.clientsMutex.RLock()
				offlineMsg := Message{
					Type: "user-offline",
					From: client.UserID,
					To:   "", // Empty To means broadcast to all
				}
				offlineMsgBytes, _ := EncodeMessage(offlineMsg)
				for userID, otherClient := range h.clients {
					select {
					case otherClient.Send <- offlineMsgBytes:
						log.Printf("Notified %s that %s is now offline", userID, client.UserID)
					default:
						// Send buffer full, skip
					}
				}
				h.clientsMutex.RUnlock()
			}

		case message := <-h.Broadcast:
			var msg Message
			if err := json.Unmarshal(message, &msg); err != nil {
				log.Printf("Error unmarshaling message: %v", err)
				continue
			}

			log.Printf("Routing message: type=%s from=%s to=%s", msg.Type, msg.From, msg.To)

			// Send message to specific recipient
			h.clientsMutex.RLock()
			targetClient, ok := h.clients[msg.To]
			h.clientsMutex.RUnlock()
			
			if ok {
				log.Printf("Target client found, sending message to %s", msg.To)
				select {
				case targetClient.Send <- message:
					log.Printf("Message sent successfully to %s", msg.To)
				default:
					log.Printf("Send buffer full for client %s, closing connection", msg.To)
					close(targetClient.Send)
					h.clientsMutex.Lock()
					delete(h.clients, targetClient.UserID)
					h.clientsMutex.Unlock()
				}
			} else {
				h.clientsMutex.RLock()
				clientIDs := getClientIDs(h.clients)
				h.clientsMutex.RUnlock()
				log.Printf("WARNING: Target client %s not found. Available clients: %v", msg.To, clientIDs)
				// If it's a call-request and user is offline, store it for when they come online
				if msg.Type == "call-request" {
					// Keep only the latest request from each caller
					h.removePendingCall(msg.To, msg.From)
					h.pendingCalls[msg.To] = append(h.pendingCalls[msg.To], pendingCall{msg: msg, storedAt: h.now()})
					log.Printf("Stored pending call-request for offline user %s (total pending: %d)", msg.To, len(h.pendingCalls[msg.To]))
				}
			}

			// Caller hung up or gave up - the call must not ring later
			if msg.Type == "call-end" {
				h.removePendingCall(msg.To, msg.From)
			}
		}
	}
}

// removePendingCall drops pending call-requests from caller to callee
func (h *Hub) removePendingCall(callee, caller string) {
	pending := h.pendingCalls[callee]
	kept := pending[:0]
	for _, p := range pending {
		if p.msg.From != caller {
			kept = append(kept, p)
		}
	}
	if len(kept) == 0 {
		delete(h.pendingCalls, callee)
	} else {
		h.pendingCalls[callee] = kept
	}
}

// DisconnectUser closes the user's WebSocket connection, if any.
// The client sees a policy-violation close and does not reconnect.
func (h *Hub) DisconnectUser(userID string) {
	h.clientsMutex.RLock()
	client, ok := h.clients[userID]
	h.clientsMutex.RUnlock()
	if !ok || client.Conn == nil {
		return
	}

	log.Printf("Disconnecting user %s", userID)
	client.Conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "unauthorized"),
		time.Now().Add(time.Second))
	// Closing the connection makes ReadPump unregister the client
	client.Conn.Close()
}
