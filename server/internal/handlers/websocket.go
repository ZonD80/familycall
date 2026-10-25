package handlers

import (
	"errors"
	"log"
	"net/http"
	"time"
	ws "familycall/server/internal/websocket"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// wsAuthTimeout is how long a new connection has to send its auth message
const wsAuthTimeout = 10 * time.Second

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins in development
	},
}

func (h *Handlers) HandleWebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	// The user is identified by their JWT, sent as the first message.
	// (Browsers can't set headers on WebSocket, and a token in the URL would end up in logs.)
	userID, err := h.authenticateWebSocket(conn)
	if err != nil {
		log.Printf("WebSocket authentication failed: %v", err)
		conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "unauthorized"),
			time.Now().Add(time.Second))
		conn.Close()
		return
	}

	client := ws.NewClient(userID, conn, h.hub)
	h.hub.Register <- client

	go client.WritePump()
	go client.ReadPump()
}

// authenticateWebSocket reads {"type":"auth","token":"..."} and returns the token's user ID
func (h *Handlers) authenticateWebSocket(conn *websocket.Conn) (string, error) {
	conn.SetReadLimit(8 * 1024)
	conn.SetReadDeadline(time.Now().Add(wsAuthTimeout))

	var msg struct {
		Type  string `json:"type"`
		Token string `json:"token"`
	}
	if err := conn.ReadJSON(&msg); err != nil {
		return "", err
	}
	if msg.Type != "auth" {
		return "", errors.New("first message must be auth")
	}

	userID, err := h.userIDFromToken(msg.Token)
	if err != nil {
		return "", err
	}

	conn.SetReadDeadline(time.Time{})
	return userID, nil
}
