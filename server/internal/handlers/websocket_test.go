package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"familycall/server/internal/config"
	"familycall/server/internal/database"
	"familycall/server/internal/models"
	ws "familycall/server/internal/websocket"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

const testSecret = "test-secret"

func newTestServer(t *testing.T) (*Handlers, *httptest.Server) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	hub := ws.NewHub()
	go hub.Run()
	db, err := database.Initialize(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	h := &Handlers{db: db, hub: hub, config: &config.Config{JWTSecret: testSecret}}

	// alice is the family organizer, bob was invited by her
	organizer := "alice"
	for _, u := range []models.User{
		{ID: "alice", Username: "Alice"},
		{ID: "bob", Username: "Bob", InvitedByUserID: &organizer},
	} {
		if err := db.Create(&u).Error; err != nil {
			t.Fatal(err)
		}
	}

	router := gin.New()
	router.GET("/ws", h.HandleWebSocket)
	router.DELETE("/contacts/:id", h.AuthMiddleware(), h.DeleteContact)
	router.GET("/protected", h.AuthMiddleware(), func(c *gin.Context) {
		c.String(http.StatusOK, c.GetString("user_id"))
	})
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)
	return h, srv
}

func dial(t *testing.T, srv *httptest.Server, query string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws" + query
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func connectAs(t *testing.T, h *Handlers, srv *httptest.Server, userID string) *websocket.Conn {
	t.Helper()
	conn := dial(t, srv, "")
	if err := conn.WriteJSON(map[string]string{"type": "auth", "token": h.generateToken(userID)}); err != nil {
		t.Fatal(err)
	}
	waitOnline(t, h, userID)
	return conn
}

func waitOnline(t *testing.T, h *Handlers, userID string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !h.hub.IsUserOnline(userID) {
		if time.Now().After(deadline) {
			t.Fatalf("%s never came online", userID)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// expectPolicyClose asserts the server closes the connection as unauthorized
func expectPolicyClose(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := conn.ReadMessage()
	if !websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
		t.Fatalf("expected policy-violation close, got %v", err)
	}
}

// readOfType reads until a message of the given type arrives (messages may be newline-batched)
func readOfType(t *testing.T, conn *websocket.Conn, msgType string) ws.Message {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for %s: %v", msgType, err)
		}
		for _, line := range strings.Split(string(data), "\n") {
			var m ws.Message
			if json.Unmarshal([]byte(line), &m) == nil && m.Type == msgType {
				return m
			}
		}
	}
}

func signedToken(t *testing.T, method jwt.SigningMethod, key interface{}, claims jwt.MapClaims) string {
	t.Helper()
	s, err := jwt.NewWithClaims(method, claims).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestWebSocketAuthenticatesWithToken(t *testing.T) {
	h, srv := newTestServer(t)
	connectAs(t, h, srv, "alice")
}

func TestWebSocketIgnoresUserIDQueryParam(t *testing.T) {
	h, srv := newTestServer(t)
	conn := dial(t, srv, "?user_id=bob")
	conn.WriteJSON(map[string]string{"type": "auth", "token": h.generateToken("alice")})

	waitOnline(t, h, "alice")
	if h.hub.IsUserOnline("bob") {
		t.Fatal("connection was registered as the user_id from the URL")
	}
}

func TestWebSocketRejectsMissingAuth(t *testing.T) {
	h, srv := newTestServer(t)
	conn := dial(t, srv, "?user_id=bob")
	// Old clients sent a ping first and relied on the user_id query param
	conn.WriteJSON(map[string]string{"type": "ping", "from": "bob"})

	expectPolicyClose(t, conn)
	if h.hub.IsUserOnline("bob") {
		t.Fatal("unauthenticated connection was registered")
	}
}

func TestWebSocketRejectsBadTokens(t *testing.T) {
	cases := map[string]string{
		"garbage":      "not-a-jwt",
		"empty":        "",
		"wrong secret": signedToken(t, jwt.SigningMethodHS256, []byte("other-secret"), jwt.MapClaims{"user_id": "bob"}),
		"other alg":    signedToken(t, jwt.SigningMethodHS512, []byte(testSecret), jwt.MapClaims{"user_id": "bob"}),
		"alg none":     signedToken(t, jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, jwt.MapClaims{"user_id": "bob"}),
		"no user_id":   signedToken(t, jwt.SigningMethodHS256, []byte(testSecret), jwt.MapClaims{"iat": 1}),
	}
	for name, token := range cases {
		t.Run(name, func(t *testing.T) {
			h, srv := newTestServer(t)
			conn := dial(t, srv, "")
			conn.WriteJSON(map[string]string{"type": "auth", "token": token})

			expectPolicyClose(t, conn)
			if h.hub.IsUserOnline("bob") {
				t.Fatal("connection with bad token was registered")
			}
		})
	}
}

func TestWebSocketStampsAuthenticatedSender(t *testing.T) {
	h, srv := newTestServer(t)
	alice := connectAs(t, h, srv, "alice")
	bob := connectAs(t, h, srv, "bob")

	// Alice pretends to be carol
	alice.WriteJSON(map[string]string{"type": "call-accept", "from": "carol", "to": "bob"})

	if got := readOfType(t, bob, "call-accept"); got.From != "alice" {
		t.Fatalf("expected sender alice, got %q", got.From)
	}
}

func TestAuthMiddlewareStillAcceptsBearerToken(t *testing.T) {
	h, srv := newTestServer(t)

	req, _ := http.NewRequest("GET", srv.URL+"/protected", nil)
	req.Header.Set("Authorization", "Bearer "+h.generateToken("alice"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	req, _ = http.NewRequest("GET", srv.URL+"/protected", nil)
	req.Header.Set("Authorization", "Bearer "+signedToken(t, jwt.SigningMethodHS256, []byte("other-secret"), jwt.MapClaims{"user_id": "alice"}))
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp2.StatusCode)
	}
}

func apiRequest(t *testing.T, srv *httptest.Server, method, path, token string) int {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func TestTokenOfUnknownUserIsRejected(t *testing.T) {
	h, srv := newTestServer(t)

	// Validly signed, but no such user
	token := h.generateToken("mallory")
	if code := apiRequest(t, srv, "GET", "/protected", token); code != http.StatusUnauthorized {
		t.Fatalf("API: expected 401, got %d", code)
	}

	conn := dial(t, srv, "")
	conn.WriteJSON(map[string]string{"type": "auth", "token": token})
	expectPolicyClose(t, conn)
}

func TestDeletingUserRevokesTokenAndDisconnects(t *testing.T) {
	h, srv := newTestServer(t)
	bobToken := h.generateToken("bob")
	bob := connectAs(t, h, srv, "bob")

	if code := apiRequest(t, srv, "DELETE", "/contacts/bob", h.generateToken("alice")); code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d", code)
	}

	// The open connection is closed as unauthorized, so the app won't reconnect
	expectPolicyClose(t, bob)
	deadline := time.Now().Add(2 * time.Second)
	for h.hub.IsUserOnline("bob") {
		if time.Now().After(deadline) {
			t.Fatal("bob is still registered after deletion")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The old token no longer works anywhere
	if code := apiRequest(t, srv, "GET", "/protected", bobToken); code != http.StatusUnauthorized {
		t.Fatalf("API: expected 401, got %d", code)
	}
	conn := dial(t, srv, "")
	conn.WriteJSON(map[string]string{"type": "auth", "token": bobToken})
	expectPolicyClose(t, conn)
}

func TestDeletedUserCannotCallOthers(t *testing.T) {
	h, srv := newTestServer(t)
	alice := connectAs(t, h, srv, "alice")
	bob := connectAs(t, h, srv, "bob")

	if code := apiRequest(t, srv, "DELETE", "/contacts/bob", h.generateToken("alice")); code != http.StatusOK {
		t.Fatalf("delete: expected 200, got %d", code)
	}
	expectPolicyClose(t, bob)

	// Writes on the closed connection must not reach alice
	bob.WriteJSON(map[string]string{"type": "call-request", "to": "alice"})
	alice.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	for {
		_, data, err := alice.ReadMessage()
		if err != nil {
			break // timeout: nothing more arrived
		}
		if strings.Contains(string(data), "call-request") {
			t.Fatalf("deleted user's call reached alice: %s", data)
		}
	}
}

func TestDisconnectUserWithoutConnectionIsNoop(t *testing.T) {
	h, _ := newTestServer(t)
	h.hub.DisconnectUser("nobody")
}
