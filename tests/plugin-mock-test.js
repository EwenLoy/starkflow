const assert = require("assert");
const path = __dirname + "/../plugin/";

// ---- stubs for the Construct runtime -----------------------------------
globalThis.C3 = { Plugins: {} };
globalThis.ISDKPluginBase = class {};
globalThis.ISDKObjectTypeBase = class {};
globalThis.ISDKInstanceBase = class {
	constructor() { this.triggered = []; }
	get runtime() { return globalThis.__FakeRuntime || null; }
	_getInitProperties() { return ["ws://x/ws", "app1", 4, true]; }   // 4 = log off
	_trigger(fn) { this.triggered.push(fn); }
	_setTicking() {}
	_release() {}
};
class FakeWS {
	constructor(url) {
		FakeWS.all.push(this);
		this.url = url; this.readyState = 0; this.sent = [];
		setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0);
	}
	send(s) { this.sent.push(JSON.parse(s)); }
	close() { this.readyState = 3; }
	recv(o) { this.onmessage({ data: JSON.stringify(o) }); }
}
FakeWS.all = [];
globalThis.WebSocket = FakeWS;

// ---- fake Construct objects (the plugin creates and moves real instances) ------
class FakeInstance {
	constructor(uid, x, y) {
		this.uid = uid; this.x = x || 0; this.y = y || 0;
		this.zElevation = 0; this.angleDegrees = 0;
		this.width = 32; this.height = 32;
		this.opacity = 1; this.isVisible = true;
		this.animationName = "idle"; this.animationFrame = 0;
		this.layer = { name: "Game" };
		this.destroyed = false;
	}
	destroy() { this.destroyed = true; globalThis.__FakeRuntime.byUid.delete(this.uid); }
}
FakeInstance.next = 1;
class FakeObjectClass {
	constructor(name) { this.name = name; this.instances = []; this.picked = []; }
	getAllInstances() { return this.instances.filter((i) => !i.destroyed); }
	getPickedInstances() { return this.picked.filter((i) => !i.destroyed); }
	createInstance(layer, x, y) {
		const inst = new FakeInstance(FakeInstance.next++, x, y);
		this.instances.push(inst);
		globalThis.__FakeRuntime.byUid.set(inst.uid, inst);
		return inst;
	}
}
const Sprite = new FakeObjectClass("Sprite");
let loop = null;
let curInst = null;
globalThis.__FakeRuntime = {
	byUid: new Map(),
	objects: { Sprite: Sprite },
	layout: { getLayer: (n) => (n === 0 || n === "Game") ? { name: "Game" } : null },
	getInstanceByUid(uid) { return this.byUid.get(uid) || null; },
	sdk: {
		createLoopingConditionContext() {
			return loop = {
				isStopped: false,
				uids: [],
				fields: [],
				retrigger() {
					this.uids.push(P.Exps.EntityUID.call(curInst));
					this.fields.push(P.Exps.EntityField.call(curInst, "x"));
				},
				release() {}
			};
		}
	}
};

for (const f of ["plugin", "type", "instance", "actions", "conditions", "expressions"])
	require(path + "c3runtime/" + f + ".js");

const P = globalThis.C3.Plugins.EwenLoy_StarkFlow;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fired = (inst, name) => inst.triggered.includes(P.Cnds[name]);

// ---- 1. every ACE in aces.json exists in the runtime with the right arity ----
const aces = require(path + "aces.json");
const lang = require(path + "lang/en-US.json").text.plugins.ewenloy_starkflow;
let n = 0;
for (const cat of Object.values(aces)) {
	for (const [kind, table, key] of [["conditions", P.Cnds, "scriptName"], ["actions", P.Acts, "scriptName"], ["expressions", P.Exps, "expressionName"]]) {
		for (const a of cat[kind]) {
			const fn = table[a[key]];
			assert.ok(typeof fn === "function", kind + " missing in runtime: " + a[key]);
			assert.strictEqual(fn.length, (a.params || []).length, "arity of " + a[key]);
			assert.ok(lang[kind][a.id], "lang missing for " + a.id);
			n++;
		}
	}
}
for (const [kind, table] of [["conditions", P.Cnds], ["actions", P.Acts], ["expressions", P.Exps]]) {
	const declared = new Set();
	for (const cat of Object.values(aces)) for (const a of cat[kind]) declared.add(a.scriptName || a.expressionName);
	for (const name of Object.keys(table)) assert.ok(declared.has(name), "runtime function not declared in aces.json: " + name);
}
console.log("ACE consistency OK (" + n + " entries)");

// ---- 2. behaviour --------------------------------------------------------
(async () => {
	const inst = new P.Instance();
	inst._retryBase = 5;

	P.Acts.Connect.call(inst, "", "");
	await sleep(5);
	let ws = FakeWS.all[0];
	assert.ok(ws.url.includes("v=1&app=app1"), ws.url);
	assert.strictEqual(ws.sent[0].t, "hello");

	ws.recv({ t: "welcome", userId: "u1", token: "tok1", serverTime: Date.now() + 5000, proto: 1 });
	assert.strictEqual(inst._status, "connected");
	assert.strictEqual(P.Exps.AuthToken.call(inst), "tok1");
	assert.ok(fired(inst, "OnConnected"));
	assert.ok(Math.abs(P.Exps.ServerTime.call(inst) - Date.now() - 5000) < 50);

	P.Acts.JoinOrCreateRoom.call(inst, "boss1", 4, 30);
	let last = ws.sent[ws.sent.length - 1];
	// «войти или создать»: сначала пробуем войти по имени
	assert.deepStrictEqual([last.t, last.room, last.create, last.maxPlayers, last.emptyTTL], ["room.join", "boss1", false, 4, 30]);
	assert.ok(typeof last.id === "number");

	// комнаты с таким именем нет -> плагин создаёт новую
	ws.recv({ t: "err", code: 300, msg: "room not found: boss1" });
	last = ws.sent[ws.sent.length - 1];
	assert.deepStrictEqual([last.t, last.room, last.create, last.maxPlayers, last.emptyTTL], ["room.join", "boss1", true, 4, 30]);

	ws.recv({ t: "room.joined", room: "boss1", roomId: "a1b2c3d4", you: 1, hostId: 1, resumed: false, maxPlayers: 4,
		players: [{ id: 1, userId: "u1", name: "A", status: "active", props: {} }], state: { boss_hp: 1000, flag: true } });
	assert.strictEqual(inst._status, "in-room");
	assert.strictEqual(P.Exps.MyId.call(inst), 1);
	assert.strictEqual(P.Exps.PlayerCount.call(inst), 1);
	assert.strictEqual(P.Exps.State.call(inst, "boss_hp"), 1000);
	assert.strictEqual(P.Exps.State.call(inst, "flag"), 1);
	assert.strictEqual(P.Exps.State.call(inst, "missing"), 0);
	assert.ok(P.Cnds.IsHost.call(inst));
	assert.ok(fired(inst, "OnJoinedRoom"));

	ws.recv({ t: "player.joined", player: { id: 2, userId: "u2", name: "B", status: "active", props: {} } });
	assert.strictEqual(P.Exps.PlayerCount.call(inst), 2);
	assert.strictEqual(P.Exps.LastPlayerId.call(inst), 2);
	assert.strictEqual(P.Exps.PlayerName.call(inst, 2), "B");
	assert.strictEqual(P.Exps.PlayerIdAt.call(inst, 1), 2);

	P.Acts.AddState.call(inst, "boss_hp", -10);
	last = ws.sent[ws.sent.length - 1];
	assert.deepStrictEqual([last.t, last.key, last.value], ["state.add", "boss_hp", -10]);
	P.Acts.SetStateBool.call(inst, "flag", 0);
	assert.strictEqual(ws.sent[ws.sent.length - 1].value, false);
	P.Acts.ToggleState.call(inst, "flag");
	assert.strictEqual(ws.sent[ws.sent.length - 1].t, "state.toggle");
	P.Acts.SendEvent.call(inst, 5, "1,2", "");
	assert.strictEqual(ws.sent[ws.sent.length - 1].to, "others");
	P.Acts.SendEvent.call(inst, 5, "x", "2");
	assert.strictEqual(ws.sent[ws.sent.length - 1].to, 2);
	P.Acts.SendEvent.call(inst, 5, "x", "ALL");
	assert.strictEqual(ws.sent[ws.sent.length - 1].to, "all");

	ws.recv({ t: "state.changed", key: "boss_hp", value: 990, old: 1000, by: 2 });
	assert.strictEqual(P.Exps.State.call(inst, "boss_hp"), 990);
	assert.ok(P.Cnds.OnStateChanged.call(inst, "boss_hp"));
	assert.ok(!P.Cnds.OnStateChanged.call(inst, "other"));
	assert.strictEqual(P.Exps.ChangedOld.call(inst), 1000);
	assert.strictEqual(P.Exps.ChangedBy.call(inst), 2);

	ws.recv({ t: "event", from: 2, code: 5, data: "3,4" });
	assert.strictEqual(P.Exps.EventData.call(inst), "3,4");
	assert.strictEqual(P.Exps.EventFrom.call(inst), 2);
	assert.ok(P.Cnds.OnEvent.call(inst, 5));
	assert.ok(!P.Cnds.OnEvent.call(inst, 6));

	ws.recv({ t: "player.props", id: 2, key: "ready", value: true });
	assert.strictEqual(P.Exps.PlayerProp.call(inst, 2, "ready"), 1);

	ws.recv({ t: "room.list.result", rooms: [
		{ id: "a1b2c3d4", room: "boss1", players: 2, maxPlayers: 4 },
		{ id: "deadbee5", room: "boss2", players: 4, maxPlayers: 4, locked: true },
	] });
	assert.strictEqual(P.Exps.RoomCount.call(inst), 2);
	assert.strictEqual(P.Exps.RoomNameAt.call(inst, 0), "boss1");
	assert.strictEqual(P.Exps.RoomIdAt.call(inst, 0), "a1b2c3d4");
	assert.strictEqual(P.Exps.RoomIdAt.call(inst, 7), "");
	assert.strictEqual(P.Exps.RoomFreeAt.call(inst, 0), 2);
	assert.strictEqual(P.Exps.RoomIsFullAt.call(inst, 0), 0);
	assert.strictEqual(P.Exps.RoomFreeAt.call(inst, 1), 0);
	assert.strictEqual(P.Exps.RoomIsFullAt.call(inst, 1), 1);
	assert.strictEqual(P.Exps.RoomLockedAt.call(inst, 1), 1);
	assert.strictEqual(P.Exps.RoomLockedAt.call(inst, 0), 0);

	// connection lost -> automatic reconnect + rejoin
	inst.triggered.length = 0;
	ws.readyState = 3;
	ws.onclose({ code: 1006 });
	assert.strictEqual(inst._status, "reconnecting");
	assert.ok(fired(inst, "OnReconnecting"));
	await sleep(40);
	ws = FakeWS.all[1];
	assert.ok(ws, "no reconnect happened");
	assert.strictEqual(ws.sent[0].t, "hello");
	assert.strictEqual(ws.sent[0].token, "tok1");
	ws.recv({ t: "welcome", userId: "u1", token: "tok2", serverTime: Date.now(), proto: 1 });
	assert.strictEqual(inst._status, "reconnecting");
	const rejoin = ws.sent[ws.sent.length - 1];
	// возврат идёт по id комнаты: имена комнат не уникальны
	assert.deepStrictEqual([rejoin.t, rejoin.room, rejoin.create], ["room.join", "a1b2c3d4", false]);
	ws.recv({ t: "room.joined", room: "boss1", roomId: "a1b2c3d4", you: 1, hostId: 1, resumed: true, maxPlayers: 4, players: [], state: { boss_hp: 990 } });
	assert.strictEqual(inst._status, "in-room");
	assert.strictEqual(P.Exps.Resumed.call(inst), 1);
	assert.strictEqual(P.Exps.RoomId.call(inst), "a1b2c3d4");

	// rejected token is forgotten
	ws.recv({ t: "err", code: 200, msg: "invalid or expired token" });
	assert.strictEqual(P.Exps.AuthToken.call(inst), "");
	assert.strictEqual(P.Exps.ErrorCode.call(inst), 200);
	assert.ok(fired(inst, "OnError"));

	// leave and disconnect
	inst.triggered.length = 0;
	P.Acts.LeaveRoom.call(inst);
	assert.strictEqual(ws.sent[ws.sent.length - 1].t, "room.leave");
	assert.strictEqual(inst._status, "connected");
	assert.ok(fired(inst, "OnLeftRoom"));
	P.Acts.Disconnect.call(inst);
	assert.strictEqual(inst._status, "disconnected");
	assert.ok(fired(inst, "OnDisconnected"));

	// protocol mismatch must not loop forever
	const inst2 = new P.Instance();
	inst2._retryBase = 5;
	P.Acts.Connect.call(inst2, "", "");
	await sleep(5);
	const w2 = FakeWS.all[FakeWS.all.length - 1];
	w2.recv({ t: "err", code: 100, msg: "unsupported protocol version" });
	w2.readyState = 3;
	w2.onclose({ code: 1000 });
	assert.strictEqual(inst2._status, "disconnected");
	assert.ok(fired(inst2, "OnDisconnected"));

	// locked room: the password goes with the join and is replayed after a reconnect
	const inst3 = new P.Instance();
	inst3._retryBase = 5;
	P.Acts.Connect.call(inst3, "", "");
	await sleep(5);
	const w3 = FakeWS.all[FakeWS.all.length - 1];
	w3.recv({ t: "welcome", userId: "u3", token: "tok3", serverTime: Date.now(), proto: 1 });
	P.Acts.JoinOrCreateRoomWithPassword.call(inst3, "boss", "secret", 4, 30);
	let m3 = w3.sent[w3.sent.length - 1];
	assert.deepStrictEqual([m3.t, m3.room, m3.create, m3.password, m3.maxPlayers, m3.emptyTTL],
		["room.join", "boss", false, "secret", 4, 30]);
	w3.recv({ t: "err", code: 300, msg: "room not found: boss" });
	m3 = w3.sent[w3.sent.length - 1];
	assert.deepStrictEqual([m3.create, m3.password], [true, "secret"]);

	inst3.triggered.length = 0;
	w3.readyState = 3;
	w3.onclose({ code: 1006 });
	await sleep(40);
	const w4 = FakeWS.all[FakeWS.all.length - 1];
	w4.recv({ t: "welcome", userId: "u3", token: "tok4", serverTime: Date.now(), proto: 1 });
	const rejoin3 = w4.sent[w4.sent.length - 1];
	assert.deepStrictEqual([rejoin3.t, rejoin3.create, rejoin3.password], ["room.join", true, "secret"]);

	// wrong password and rate limit both arrive as ordinary errors
	w4.recv({ t: "err", code: 307, msg: "wrong room password" });
	assert.strictEqual(P.Exps.ErrorCode.call(inst3), 307);
	assert.ok(!fired(inst3, "OnRateLimited"));
	w4.recv({ t: "err", code: 500, msg: "too many messages" });
	assert.strictEqual(P.Exps.ErrorCode.call(inst3), 500);
	assert.ok(fired(inst3, "OnRateLimited"));
	assert.ok(fired(inst3, "OnError"));

	// ---- 3. the simple object sync API --------------------------------------
	const inst4 = new P.Instance();
	inst4._retryBase = 5;
	P.Acts.Connect.call(inst4, "", "");
	await sleep(5);
	const w5 = FakeWS.all[FakeWS.all.length - 1];
	w5.recv({ t: "welcome", userId: "u4", token: "t4", serverTime: Date.now(), proto: 1 });
	P.Acts.JoinOrCreateRoom.call(inst4, "arena", 8, 30);
	w5.recv({ t: "room.joined", room: "arena", roomId: "r1", you: 1, hostId: 1, maxPlayers: 8, players: [{ id: 1, name: "me", props: {} }], state: {} });

	// my sprite: the instance that is in the layout becomes mine
	const mine = Sprite.createInstance("Game", 100, 200);
	assert.strictEqual(P.Cnds.IsSyncing.call(inst4), false);
	P.Acts.SyncObject.call(inst4, Sprite, "player", "player", "positionAngle", true, "");
	P.Acts.StartSync.call(inst4);
	assert.strictEqual(P.Cnds.IsSyncing.call(inst4), true);
	assert.strictEqual(P.Exps.LocalEntityUID.call(inst4, "player"), mine.uid);

	// it goes out as a player property and carries its tag
	inst4._flush(performance.now());
	let sent = w5.sent[w5.sent.length - 1];
	assert.deepStrictEqual([sent.t, sent.key, sent.value], ["player.set", "_sf0", '[[0,1035,100,200,0,"player"]]']);

	// a second player joins: his data arrives and the plugin creates his sprite
	inst4.triggered.length = 0;
	const payload = JSON.stringify([[3, 1035, 10.5, 20, 45, "player"]]);
	w5.recv({ t: "player.joined", player: { id: 2, name: "bob", props: { _sf0: payload } } });
	assert.ok(fired(inst4, "OnProxyCreated"), "On other player's object created must fire");
	const bob = P.Exps.PlayerProxyUID.call(inst4, 2, "player");
	assert.ok(bob > 0, "the object of player 2 must exist");
	assert.strictEqual(P.Exps.ProxyUID.call(inst4), bob);
	assert.strictEqual(P.Exps.ProxyPlayerId.call(inst4), 2);
	assert.strictEqual(P.Exps.ProxyTag.call(inst4), "player");
	assert.strictEqual(P.Exps.EntityCount.call(inst4, "player"), 2);
	assert.strictEqual(P.Exps.EntityCount.call(inst4, ""), 2);

	inst4._applyRemote(16);
	const remote = globalThis.__FakeRuntime.getInstanceByUid(bob);
	assert.deepStrictEqual([remote.x, remote.y, remote.angleDegrees], [10.5, 20, 45]);

	// "For each object" walks over mine and over his
	curInst = inst4;
	assert.strictEqual(P.Cnds.ForEachEntity.call(inst4, "player"), false);
	assert.deepStrictEqual(loop.uids, [mine.uid, bob]);
	assert.deepStrictEqual(loop.fields, [100, 10.5]);

	// he stops sending: his sprite is removed
	inst4.triggered.length = 0;
	w5.recv({ t: "player.props", id: 2, key: "_sf0", value: "" });
	assert.strictEqual(P.Exps.PlayerProxyUID.call(inst4, 2, "player"), 0);
	assert.ok(remote.destroyed, "the instance of player 2 must be destroyed");
	assert.ok(fired(inst4, "OnProxyDestroyed"));
	assert.strictEqual(P.Exps.EntityCount.call(inst4, "player"), 1);

	// "Stop sync" also clears my data on the server
	P.Acts.StopSync.call(inst4);
	assert.strictEqual(P.Cnds.IsSyncing.call(inst4), false);
	sent = w5.sent[w5.sent.length - 1];
	assert.deepStrictEqual([sent.t, sent.key, sent.value], ["player.set", "_sf0", ""]);

	console.log("Behaviour tests OK");
	process.exit(0);
})().catch((e) => { console.error("TEST FAILED:", e.message); process.exit(1); });
