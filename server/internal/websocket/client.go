package websocket

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Time allowed to write a message to the peer
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer
	pongWait = 60 * time.Second

	// Send pings to peer with this period (must be less than pongWait)
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer
	maxMessageSize = 512 * 1024 // 512KB
)

type Client struct {
	UserID      string
	Hub         *Hub
	Conn        *websocket.Conn
	Send        chan []byte
	LastActivity time.Time // Track last activity for online status
}

func NewClient(userID string, conn *websocket.Conn, hub *Hub) *Client {
	return &Client{
		UserID:       userID,
		Hub:          hub,
		Conn:         conn,
		Send:         make(chan []byte, 256),
		LastActivity: time.Now(),
	}
}

// ReadPump pumps messages from the websocket connection to the hub
func (c *Client) ReadPump() {
	defer func() {
		c.Hub.Unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.LastActivity = time.Now()
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		// Update last activity
		c.LastActivity = time.Now()

		// Never trust the sender ID supplied by the client
		message, err = stampSender(message, c.UserID)
		if err != nil {
			log.Printf("Dropping malformed message from %s: %v", c.UserID, err)
			continue
		}

		// Broadcast message to hub
		c.Hub.Broadcast <- message
	}
}

// stampSender sets the message's From field to the authenticated user ID
func stampSender(message []byte, userID string) ([]byte, error) {
	var msg Message
	if err := json.Unmarshal(message, &msg); err != nil {
		return nil, err
	}
	msg.From = userID
	return EncodeMessage(msg)
}

// WritePump pumps messages from the hub to the websocket connection
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.Conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Add queued messages to the current websocket message
			n := len(c.Send)
			for i := 0; i < n; i++ {
				w.Write([]byte{'\n'})
				w.Write(<-c.Send)
			}

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
			// Update LastActivity after sending ping (pong will also update it)
			c.LastActivity = time.Now()
		}
	}
}

// SendMessage sends a message to this client
func (c *Client) SendMessage(msg Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	select {
	case c.Send <- data:
	default:
		log.Printf("Client %s send buffer full", c.UserID)
	}

	return nil
}

