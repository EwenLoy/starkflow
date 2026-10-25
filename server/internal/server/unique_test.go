package server

import "testing"

// scan looks for the last message of this type; the caller holds c.mu, which is
// what waitFor does while it evaluates the condition.
func scan(c *tclient, typ string) map[string]any {
	for i := len(c.wsMsgs) - 1; i >= 0; i-- {
		if c.wsMsgs[i]["t"] == typ {
			return c.wsMsgs[i]
		}
	}
	return nil
}

func msgOf(c *tclient, typ string) map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return scan(c, typ)
}

func roomsOf(c *tclient) []any {
	m := msgOf(c, "room.list.result")
	if m == nil {
		return nil
	}
	rooms, _ := m["rooms"].([]any)
	return rooms
}

func countName(rooms []any, name string) int {
	n := 0
	for _, r := range rooms {
		if rm, ok := r.(map[string]any); ok && rm["room"] == name {
			n++
		}
	}
	return n
}

func TestWelcomeAdvertisesUnique(t *testing.T) {
	hs := testServer(t, 0)
	c := dial(t, hs)
	if c.welcome["unique"] != true {
		t.Fatalf("welcome.unique = %v, want true", c.welcome["unique"])
	}
}

// A room created with unique=true occupies its name: a second create with the
// same name is refused with 308 instead of making a duplicate, so a room code
// always points at exactly one room.
func TestCreateRoomUnique(t *testing.T) {
	hs := testServer(t, 0)
	a := dial(t, hs)
	b := dial(t, hs)

	a.send(map[string]any{"t": "room.join", "id": 1, "room": "code42", "create": true, "unique": true, "name": "A"})
	a.waitFor(func() bool { return scan(a, "room.joined") != nil }, "room.joined (a)")
	if j := msgOf(a, "room.joined"); j["created"] != true {
		t.Fatalf("the room of the creator must come with created=true: %v", j)
	}

	b.send(map[string]any{"t": "room.join", "id": 2, "room": "code42", "create": true, "unique": true, "name": "B"})
	b.waitFor(func() bool { return scan(b, "err") != nil }, "err (b)")
	e := msgOf(b, "err")
	if e["code"] != float64(308) {
		t.Fatalf("a duplicate name = %v, want code 308", e)
	}
	if msgOf(b, "room.joined") != nil {
		t.Fatal("a refused create must not enter the room")
	}

	a.send(map[string]any{"t": "room.list", "id": 3})
	a.waitFor(func() bool { return scan(a, "room.list.result") != nil }, "room.list.result")
	if n := countName(roomsOf(a), "code42"); n != 1 {
		t.Fatalf("%d rooms named code42, want 1", n)
	}

	// the same name can still be entered, and that join is not a creation
	b.send(map[string]any{"t": "room.join", "id": 4, "room": "code42", "create": false, "name": "B"})
	b.waitFor(func() bool { return scan(b, "room.joined") != nil }, "room.joined (b)")
	if j := msgOf(b, "room.joined"); j["created"] != false {
		t.Fatalf("joining an existing room must come with created=false: %v", j)
	}
}

// Without unique the old rule still holds: create=true always makes a new room,
// even with an equal name. Join or create room relies on it.
func TestCreateRoomWithoutUnique(t *testing.T) {
	hs := testServer(t, 0)
	a := dial(t, hs)
	b := dial(t, hs)

	a.send(map[string]any{"t": "room.join", "id": 1, "room": "boss", "create": true, "name": "A"})
	a.waitFor(func() bool { return scan(a, "room.joined") != nil }, "room.joined (a)")
	b.send(map[string]any{"t": "room.join", "id": 2, "room": "boss", "create": true, "name": "B"})
	b.waitFor(func() bool { return scan(b, "room.joined") != nil || scan(b, "err") != nil }, "room.joined (b)")

	if msgOf(b, "err") != nil {
		t.Fatalf("without unique a duplicate name is allowed, got %v", msgOf(b, "err"))
	}
	a.send(map[string]any{"t": "room.list", "id": 3})
	a.waitFor(func() bool { return scan(a, "room.list.result") != nil }, "room.list.result")
	if n := countName(roomsOf(a), "boss"); n != 2 {
		t.Fatalf("%d rooms named boss, want 2", n)
	}
}
