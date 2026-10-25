package handlers

import (
	"net/http"
	"familycall/server/internal/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type CreateContactRequest struct {
	ContactName string `json:"contact_name" binding:"required,min=3,max=100"`
}

type ContactResponse struct {
	ID          string `json:"id"`           // User ID (same as contact_id)
	ContactID   string `json:"contact_id"`   // User ID (same as id)
	ContactName string `json:"contact_name"` // Username
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	IsOnline    bool   `json:"is_online"`
	HasPush     bool   `json:"has_push"`
}

func (h *Handlers) GetContacts(c *gin.Context) {
	userID, _ := c.Get("user_id")

	// Get all users except yourself - they are your contacts
	var users []models.User
	if err := h.db.Where("id != ?", userID).Find(&users).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to fetch contacts"})
		return
	}

	// Get online users from WebSocket hub
	onlineUsers := h.hub.GetOnlineUsers()
	
	// Check push subscriptions for each user
	var userIDs []string
	for _, user := range users {
		userIDs = append(userIDs, user.ID)
	}
	
	var pushSubscriptions []models.PushSubscription
	if len(userIDs) > 0 {
		h.db.Where("user_id IN ?", userIDs).Find(&pushSubscriptions)
	}
	
	// Create map of user IDs with push subscriptions
	pushUsers := make(map[string]bool)
	for _, sub := range pushSubscriptions {
		pushUsers[sub.UserID] = true
	}

	// Build response with online status and push subscription info
	response := make([]ContactResponse, 0, len(users))
	for _, user := range users {
		response = append(response, ContactResponse{
			ID:          user.ID,
			ContactID:   user.ID, // Same as ID - user = contact
			ContactName: user.Username,
			CreatedAt:   user.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
			UpdatedAt:   user.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
			IsOnline:    onlineUsers[user.ID],
			HasPush:     pushUsers[user.ID],
		})
	}

	c.JSON(http.StatusOK, response)
}

func (h *Handlers) CreateContact(c *gin.Context) {
	userID, _ := c.Get("user_id")

	// Check if current user is the first user
	var currentUser models.User
	if err := h.db.First(&currentUser, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	isFirstUser := currentUser.InvitedByUserID == nil || userCount == 1
	
	if userCount > 1 && currentUser.InvitedByUserID == nil {
		var oldestUser models.User
		h.db.Order("created_at ASC").First(&oldestUser)
		isFirstUser = oldestUser.ID == currentUser.ID
	}
	
	if !isFirstUser {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the family organizer can invite new users"})
		return
	}

	var req CreateContactRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Check if user with this username already exists
	var existingUser models.User
	if err := h.db.Where("username = ?", req.ContactName).First(&existingUser).Error; err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "User with this name already exists"})
		return
	}

	// Create an invite - this will create a user when accepted
	invite := models.Invite{
		FromUserID:  userID.(string),
		ContactName: req.ContactName,
	}

	if err := h.db.Create(&invite).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create invite"})
		return
	}

	h.db.Preload("FromUser").First(&invite, invite.ID)

	c.JSON(http.StatusCreated, gin.H{
		"message": "Invite created",
		"invite":   invite,
		"invite_link": "/invite/" + invite.UUID,
	})
}

func (h *Handlers) DeleteContact(c *gin.Context) {
	userID, _ := c.Get("user_id")
	contactID := c.Param("id")

	// Check if current user is the first user
	var currentUser models.User
	if err := h.db.First(&currentUser, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	isFirstUser := currentUser.InvitedByUserID == nil || userCount == 1
	
	if userCount > 1 && currentUser.InvitedByUserID == nil {
		var oldestUser models.User
		h.db.Order("created_at ASC").First(&oldestUser)
		isFirstUser = oldestUser.ID == currentUser.ID
	}
	
	if !isFirstUser {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the family organizer can delete users"})
		return
	}

	// Prevent deleting yourself
	if contactID == userID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot delete yourself"})
		return
	}

	// Check if user exists
	var user models.User
	if err := h.db.Where("id = ?", contactID).First(&user).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			c.JSON(http.StatusNotFound, gin.H{"error": "Contact not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// Delete the user (they are the contact)
	if err := h.db.Delete(&user).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete contact"})
		return
	}

	// Their token is no longer accepted; also drop a connection that is already open
	h.hub.DisconnectUser(user.ID)

	c.JSON(http.StatusOK, gin.H{"message": "Contact deleted"})
}

