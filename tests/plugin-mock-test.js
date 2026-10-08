const assert = require("assert");
const path = __dirname + "/../plugin/";

// ---- stubs for the Construct runtime -----------------------------------
globalThis.C3 = { Plugins: {} };
globalThis.ISDKPluginBase = class {};
globalThis.ISDKObjectTypeBase = class {};
globalThis.ISDKInstanceBase = class {
	constructor() { this.triggered = []; }
	_getInitProperties() { return ["ws://x/ws", "app1", 4, true]; }   // 4 = log off
	_trigger(fn) { this.triggered.push(fn); }
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

	ws.recv({ t: "room.list.result", rooms: [{ id: "a1b2c3d4", room: "boss1", players: 2, maxPlayers: 4 }] });
	assert.strictEqual(P.Exps.RoomCount.call(inst), 1);
	assert.strictEqual(P.Exps.RoomNameAt.call(inst, 0), "boss1");

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

	console.log("Behaviour tests OK");
})().catch((e) => { console.error("TEST FAILED:", e.message); process.exit(1); });
