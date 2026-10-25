package websocket

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newTestHub(t *testing.T) (*Hub, *fakeClock) {
	t.Helper()
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	h := NewHub()
	h.now = clock.Now
	go h.Run()
	return h, clock
}

func newTestClient(userID string) *Client {
	return &Client{UserID: userID, Send: make(chan []byte, 16), LastActivity: time.Now()}
}

func send(t *testing.T, h *Hub, msg Message) {
	t.Helper()
	b, err := EncodeMessage(msg)
	if err != nil {
		t.Fatal(err)
	}
	h.Broadcast <- b
}

// flush waits until the hub has finished processing previously sent messages
func flush(t *testing.T, h *Hub) {
	t.Helper()
	send(t, h, Message{Type: "ping"})
}

// receivedOfType drains the client's queue and returns messages of the given type
func receivedOfType(t *testing.T, c *Client, msgType string) []Message {
	t.Helper()
	var out []Message
	timeout := time.After(200 * time.Millisecond)
	for {
		select {
		case b := <-c.Send:
			var m Message
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatalf("bad message: %v", err)
			}
			if m.Type == msgType {
				out = append(out, m)
			}
		case <-timeout:
			return out
		}
	}
}

func callRequest(from, to string) Message {
	return Message{Type: "call-request", From: from, To: to, CallType: "video"}
}

func TestPendingCallDeliveredWhenCalleeComesOnline(t *testing.T) {
	h, _ := newTestHub(t)
	send(t, h, callRequest("alice", "bob"))

	bob := newTestClient("bob")
	h.Register <- bob

	got := receivedOfType(t, bob, "call-request")
	if len(got) != 1 || got[0].From != "alice" {
		t.Fatalf("expected one call-request from alice, got %+v", got)
	}
}

func TestExpiredPendingCallIsDropped(t *testing.T) {
	h, clock := newTestHub(t)
	send(t, h, callRequest("alice", "bob"))
	flush(t, h)

	clock.Advance(PendingCallTTL + time.Second)
	bob := newTestClient("bob")
	h.Register <- bob

	if got := receivedOfType(t, bob, "call-request"); len(got) != 0 {
		t.Fatalf("expected expired call to be dropped, got %+v", got)
	}
}

func TestDuplicatePendingCallsFromSameCallerCollapse(t *testing.T) {
	h, _ := newTestHub(t)
	send(t, h, callRequest("alice", "bob"))
	send(t, h, callRequest("alice", "bob"))
	send(t, h, callRequest("carol", "bob"))

	bob := newTestClient("bob")
	h.Register <- bob

	got := receivedOfType(t, bob, "call-request")
	if len(got) != 2 {
		t.Fatalf("expected one request per caller, got %+v", got)
	}
}

func TestCallEndCancelsPendingCall(t *testing.T) {
	h, _ := newTestHub(t)
	send(t, h, callRequest("alice", "bob"))
	send(t, h, callRequest("carol", "bob"))
	send(t, h, Message{Type: "call-end", From: "alice", To: "bob"})

	bob := newTestClient("bob")
	h.Register <- bob

	got := receivedOfType(t, bob, "call-request")
	if len(got) != 1 || got[0].From != "carol" {
		t.Fatalf("expected only carol's call to remain, got %+v", got)
	}
}

func TestPendingCallsAreDeliveredOnlyOnce(t *testing.T) {
	h, _ := newTestHub(t)
	send(t, h, callRequest("alice", "bob"))

	bob := newTestClient("bob")
	h.Register <- bob
	receivedOfType(t, bob, "call-request")
	h.Unregister <- bob

	bob2 := newTestClient("bob")
	h.Register <- bob2
	if got := receivedOfType(t, bob2, "call-request"); len(got) != 0 {
		t.Fatalf("expected no redelivery, got %+v", got)
	}
}

func TestStampSenderOverridesSpoofedFrom(t *testing.T) {
	in := []byte(`{"type":"call-accept","from":"mallory-pretends-to-be-alice","to":"bob","data":{"reason":"busy"}}`)
	out, err := stampSender(in, "mallory")
	if err != nil {
		t.Fatal(err)
	}
	var m Message
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	if m.From != "mallory" || m.To != "bob" || m.Type != "call-accept" {
		t.Fatalf("unexpected message: %+v", m)
	}
	if data, ok := m.Data.(map[string]interface{}); !ok || data["reason"] != "busy" {
		t.Fatalf("data not preserved: %+v", m.Data)
	}
}

func TestStampSenderRejectsMalformedMessage(t *testing.T) {
	if _, err := stampSender([]byte("not json"), "mallory"); err == nil {
		t.Fatal("expected error for malformed message")
	}
}
