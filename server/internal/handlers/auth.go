package handlers

import (
	"errors"
	"net/http"
	"familycall/server/internal/config"
	"familycall/server/internal/models"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm"
)

type AuthHandler struct {
	db     *gorm.DB
	config *config.Config
}

type RegisterRequest struct {
	Username  string `json:"username" binding:"required,min=3,max=100"`
	InviteUUID string `json:"invite_uuid,omitempty"` // Optional: UUID of invite being accepted
}

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
}

type LoginResponse struct {
	Token string           `json:"token"`
	User  models.User      `json:"user"`
}

func (h *Handlers) Register(c *gin.Context) {
	var req RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Check if first user already exists (user with no InvitedByUserID or oldest user)
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	
	if userCount > 0 {
		// First user exists, check if this is an invite-based registration
		if req.InviteUUID == "" {
			// No invite UUID provided, registration is disabled
			c.JSON(http.StatusForbidden, gin.H{
				"error": "Registration is disabled. Get an invite from family organizer to use Family Callbook",
			})
			return
		}
		
		// Verify the invite exists and matches the username
		var invite models.Invite
		if err := h.db.Where("uuid = ? AND contact_name = ?", req.InviteUUID, req.Username).First(&invite).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				c.JSON(http.StatusForbidden, gin.H{
					"error": "Invalid invite or username mismatch. Please use the invite link provided.",
				})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
			return
		}
		
		// Check if invite was already accepted (user with this name exists)
		var existingUser models.User
		if h.db.Where("username = ?", req.Username).First(&existingUser).Error == nil {
			c.JSON(http.StatusConflict, gin.H{"error": "User with this name already exists"})
			return
		}
		
		// Valid invite, allow registration - user will be created with InvitedByUserID set
		user := models.User{
			Username:       req.Username,
			InvitedByUserID: &invite.FromUserID,
		}
		
		if err := h.db.Create(&user).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create user"})
			return
		}
		
		// Generate JWT token
		token := h.generateToken(user.ID)
		
		c.JSON(http.StatusCreated, LoginResponse{
			Token: token,
			User:  user,
		})
		return
	}

	// Check if username already exists
	var existingUser models.User
	if err := h.db.Where("username = ?", req.Username).First(&existingUser).Error; err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Username already exists"})
		return
	}

	// Create new user (first user - no InvitedByUserID)
	user := models.User{
		Username: req.Username,
		// InvitedByUserID is nil for first user
	}

	if err := h.db.Create(&user).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create user"})
		return
	}

	// Generate JWT token
	token := h.generateToken(user.ID)

	c.JSON(http.StatusCreated, LoginResponse{
		Token: token,
		User:  user,
	})
}

func (h *Handlers) Login(c *gin.Context) {
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Find user
	var user models.User
	if err := h.db.Where("username = ?", req.Username).First(&user).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid username"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Database error"})
		return
	}

	// Generate JWT token
	token := h.generateToken(user.ID)

	c.JSON(http.StatusOK, LoginResponse{
		Token: token,
		User:  user,
	})
}

func (h *Handlers) GetMe(c *gin.Context) {
	userID, exists := c.Get("user_id")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized"})
		return
	}

	var user models.User
	if err := h.db.First(&user, "id = ?", userID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}

	// Check if this is the first user (no InvitedByUserID or oldest user)
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	isFirstUser := user.InvitedByUserID == nil || userCount == 1
	
	// If multiple users exist, find the oldest one
	if userCount > 1 && user.InvitedByUserID == nil {
		var oldestUser models.User
		h.db.Order("created_at ASC").First(&oldestUser)
		isFirstUser = oldestUser.ID == user.ID
	}

	response := gin.H{
		"id":            user.ID,
		"username":      user.Username,
		"created_at":    user.CreatedAt,
		"updated_at":    user.UpdatedAt,
		"is_first_user": isFirstUser,
	}

	c.JSON(http.StatusOK, response)
}

// CheckRegistrationStatus checks if registration is enabled
func (h *Handlers) CheckRegistrationStatus(c *gin.Context) {
	var userCount int64
	h.db.Model(&models.User{}).Count(&userCount)
	
	c.JSON(http.StatusOK, gin.H{
		"registration_enabled": userCount == 0,
		"message":              "Get an invite from family organizer to use Family Callbook",
	})
}

// RenameUser renames a user (only first user can rename themselves or others)
func (h *Handlers) RenameUser(c *gin.Context) {
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
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the family organizer can rename users"})
		return
	}
	
	var req struct {
		UserID   string `json:"user_id" binding:"required"`
		Username string `json:"username" binding:"required,min=3,max=100"`
	}
	
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	
	// Check if username already exists (excluding the user being renamed)
	var existingUser models.User
	if err := h.db.Where("username = ? AND id != ?", req.Username, req.UserID).First(&existingUser).Error; err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Username already exists"})
		return
	}
	
	// Get the user to rename
	var userToRename models.User
	if err := h.db.First(&userToRename, "id = ?", req.UserID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User to rename not found"})
		return
	}
	
	// Update username
	userToRename.Username = req.Username
	if err := h.db.Save(&userToRename).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to rename user"})
		return
	}
	
	c.JSON(http.StatusOK, gin.H{
		"message": "User renamed successfully",
		"user":    userToRename,
	})
}

func (h *Handlers) generateToken(userID string) string {
	claims := jwt.MapClaims{
		"user_id": userID,
		"iat":     time.Now().Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	tokenString, _ := token.SignedString([]byte(h.config.JWTSecret))
	return tokenString
}

// userIDFromToken validates a JWT issued by generateToken and returns its user ID
func (h *Handlers) userIDFromToken(tokenString string) (string, error) {
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		return []byte(h.config.JWTSecret), nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))

	if err != nil || !token.Valid {
		return "", errors.New("Invalid token")
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return "", errors.New("Invalid token claims")
	}

	userID, ok := claims["user_id"].(string)
	if !ok || userID == "" {
		return "", errors.New("Invalid user ID in token")
	}

	// Tokens of deleted users are revoked
	var count int64
	if err := h.db.Model(&models.User{}).Where("id = ?", userID).Count(&count).Error; err != nil || count == 0 {
		return "", errors.New("User not found")
	}

	return userID, nil
}

func (h *Handlers) AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		tokenString := c.GetHeader("Authorization")
		if tokenString == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authorization header required"})
			c.Abort()
			return
		}

		// Remove "Bearer " prefix if present
		if len(tokenString) > 7 && tokenString[:7] == "Bearer " {
			tokenString = tokenString[7:]
		}

		userID, err := h.userIDFromToken(tokenString)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			c.Abort()
			return
		}

		c.Set("user_id", userID)
		c.Next()
	}
}

