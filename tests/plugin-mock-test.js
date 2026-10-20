const assert = require("assert");
const path = __dirname + "/../plugin/";

// ---- stubs for the Construct runtime -----------------------------------
globalThis.C3 = { Plugins: {} };
globalThis.ISDKPluginBase = class {};
globalThis.ISDKObjectTypeBase = class {};
globalThis.ISDKInstanceBase = class {
	constructor() { this.triggered = []; }
	get runtime() { return this.__runtime || globalThis.__FakeRuntime || null; }
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
		this.instVars = { hp: 100, ammo: 5 };
		this.destroyed = false;
	}
	destroy() { this.destroyed = true; (this.rt || globalThis.__FakeRuntime).byUid.delete(this.uid); }
}
FakeInstance.next = 1;
class FakeObjectClass {
	constructor(name) { this.name = name; this.instances = []; this.picked = []; }
	getAllInstances() { return this.instances.filter((i) => !i.destroyed); }
	getPickedInstances() { return this.picked.filter((i) => !i.destroyed); }
	createInstance(layer, x, y) {
		const inst = new FakeInstance(FakeInstance.next++, x, y);
		inst.rt = this.rt || globalThis.__FakeRuntime;
		this.instances.push(inst);
		inst.rt.byUid.set(inst.uid, inst);
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

// ---- 0. the plugin never opens a browser dialog --------------------------
const fs = require("fs");
const pluginFiles = ["plugin.js", "type.js", "instance.js",
	"c3runtime/plugin.js", "c3runtime/type.js", "c3runtime/instance.js",
	"c3runtime/actions.js", "c3runtime/conditions.js", "c3runtime/expressions.js",
	"aces.json", "lang/en-US.json"];
const DIALOG = /\balert\s*\(|\bwindow\s*\.\s*alert|\bconfirm\s*\(|\bprompt\s*\(/;
for (const f of pluginFiles) {
	const src = fs.readFileSync(path + f, "utf8");
	assert.ok(!DIALOG.test(src), f + " must not open a browser dialog (alert/confirm/prompt): everything goes to the log");
}
console.log("No browser dialogs in the plugin");

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
			// Every declared parameter must have a localized name, and every combo item of
			// aces.json must have a localized label (otherwise C3 shows the raw id/value).
			const lparams = lang[kind][a.id].params || {};
			for (const p of (a.params || [])) {
				assert.ok(lparams[p.id] && lparams[p.id].name,
					"lang param name missing for " + a.id + "." + p.id);
				if (p.type !== "combo") continue;
				const items = lparams[p.id].items || {};
				for (const it of p.items) assert.ok(items[it], "lang combo item missing for " + a.id + "." + p.id + "." + it);
				for (const it of Object.keys(items)) assert.ok(p.items.includes(it),
					"lang combo item " + a.id + "." + p.id + "." + it + " is not in aces.json");
			}
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
	// В«РІРѕР№С‚Рё РёР»Рё СЃРѕР·РґР°С‚СЊВ»: СЃРЅР°С‡Р°Р»Р° РїСЂРѕР±СѓРµРј РІРѕР№С‚Рё РїРѕ РёРјРµРЅРё
	assert.deepStrictEqual([last.t, last.room, last.create, last.maxPlayers, last.emptyTTL], ["room.join", "boss1", false, 4, 30]);
	assert.ok(typeof last.id === "number");

	// РєРѕРјРЅР°С‚С‹ СЃ С‚Р°РєРёРј РёРјРµРЅРµРј РЅРµС‚ -> РїР»Р°РіРёРЅ СЃРѕР·РґР°С‘С‚ РЅРѕРІСѓСЋ
	ws.recv({ t: "err", code: 300, msg: "room not found: boss1" });
	last = ws.sent[ws.sent.length - 1];
	assert.deepStrictEqual([last.t, last.room, last.create, last.maxPlayers, last.emptyTTL], ["room.join", "boss1", true, 4, 30]);
	// В«РІРѕР№С‚Рё РёР»Рё СЃРѕР·РґР°С‚СЊВ»: РїСЂРѕР±РЅС‹Р№ РІС…РѕРґ РІ РѕС‚СЃСѓС‚СЃС‚РІСѓСЋС‰СѓСЋ РєРѕРјРЅР°С‚Сѓ вЂ” С€С‚Р°С‚РЅР°СЏ РІРµС‚РєР°, Р° РЅРµ
	// РѕС€РёР±РєР°, РїРѕСЌС‚РѕРјСѓ On error СЃСЂР°Р±Р°С‚С‹РІР°С‚СЊ РЅРµ РґРѕР»Р¶РµРЅ (РІ Р±СЂР°СѓР·РµСЂРµ РЅРµ РґРѕР»Р¶РЅРѕ РІСЃРїР»С‹РІР°С‚СЊ
	// Р»РѕР¶РЅРѕРµ В«РєРѕРјРЅР°С‚Р° РЅРµ РЅР°Р№РґРµРЅР°В» РїРѕСЃСЂРµРґРё СѓСЃРїРµС€РЅРѕРіРѕ РІС…РѕРґР°).
	assert.ok(!fired(inst, "OnError"), "the JoinOrCreateRoom probe must not fire On error");

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
	// РІРѕР·РІСЂР°С‚ РёРґС‘С‚ РїРѕ id РєРѕРјРЅР°С‚С‹: РёРјРµРЅР° РєРѕРјРЅР°С‚ РЅРµ СѓРЅРёРєР°Р»СЊРЅС‹
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
	assert.ok(!fired(inst3, "OnError"), "the password probe must not fire On error");

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
	// my nickname is known before joining: it is what the game set
	P.Acts.SetName.call(inst4, "nick");
	assert.strictEqual(P.Exps.MyName.call(inst4), "nick");
	P.Acts.Connect.call(inst4, "", "");
	await sleep(5);
	const w5 = FakeWS.all[FakeWS.all.length - 1];
	w5.recv({ t: "welcome", userId: "u4", token: "t4", serverTime: Date.now(), proto: 1 });
	P.Acts.JoinOrCreateRoom.call(inst4, "arena", 8, 30);
	w5.recv({ t: "room.joined", room: "arena", roomId: "r1", you: 1, hostId: 1, maxPlayers: 8, players: [{ id: 1, name: "me", props: {} }], state: {} });

	// after joining the room the server is the source of truth for nicknames
	assert.strictEqual(P.Exps.MyName.call(inst4), "me");
	assert.strictEqual(P.Exps.PlayerName.call(inst4, P.Exps.MyId.call(inst4)), "me");
	assert.strictEqual(P.Exps.PlayerNameAt.call(inst4, 0), "me");
	assert.strictEqual(P.Exps.PlayerNameAt.call(inst4, 5), "");

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

	// ---- send rate presets and smoothing ------------------------------------
	// Construct hands combo parameters over as the index of the chosen item, but the
	// item id must keep working too (older projects and hand-written calls).
	P.Acts.SetSendRatePreset.call(inst4, "fast");
	assert.strictEqual(P.Exps.SendRate.call(inst4), 58, "the send rate preset by item id");
	P.Acts.SetSendRatePreset.call(inst4, 2);
	assert.strictEqual(P.Exps.SendRate.call(inst4), 15, "the send rate preset by index (2 = slow)");
	P.Acts.SetSendRatePreset.call(inst4, 1);
	assert.strictEqual(P.Exps.SendRate.call(inst4), 30, "the send rate preset by index (1 = medium)");

	// smoothing "auto" (the default) is 1.4 x the send interval, kept in 70..300 ms
	assert.strictEqual(P.Exps.Smoothing.call(inst4), 70, "auto smoothing at 30/s must be 70 ms");
	P.Acts.SetSendRatePreset.call(inst4, 2);            // 15/s -> 66.7 x 1.4 = 93
	assert.strictEqual(P.Exps.Smoothing.call(inst4), 93, "auto smoothing must follow the send interval");
	P.Acts.SetSmoothing.call(inst4, 120);
	assert.strictEqual(P.Exps.Smoothing.call(inst4), 120, "a manual smoothing value must win");
	P.Acts.SetSmoothing.call(inst4, 0);
	assert.strictEqual(P.Exps.Smoothing.call(inst4), 0, "0 must turn smoothing off");
	P.Acts.SetAutoSmoothing.call(inst4);
	assert.strictEqual(P.Exps.Smoothing.call(inst4), 93, "\"Set smoothing (auto)\" must go back to the automatic value");
	P.Acts.SetSendRatePreset.call(inst4, 1);            // back to the default 30/s
	assert.strictEqual(P.Exps.Smoothing.call(inst4), 70);

	// a second player joins: his data arrives and the plugin creates his sprite
	inst4.triggered.length = 0;
	const payload = JSON.stringify([[3, 1035, 10.5, 20, 45, "player"]]);
	w5.recv({ t: "player.joined", player: { id: 2, name: "bob", props: { _sf0: payload } } });
	assert.ok(fired(inst4, "OnProxyCreated"), "On other player's object created must fire");
	// his nickname: by id, by the trigger's LastPlayerId and by index
	assert.strictEqual(P.Exps.PlayerName.call(inst4, P.Exps.LastPlayerId.call(inst4)), "bob");
	assert.strictEqual(P.Exps.PlayerNameAt.call(inst4, 1), "bob");
	assert.strictEqual(P.Exps.PlayerUserId.call(inst4, 2), "");
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

	// "For each player" walks the room; CurrentPlayerId + PlayerName give the nickname
	const origMkLoop = globalThis.__FakeRuntime.sdk.createLoopingConditionContext;
	const seenPlayers = [];
	globalThis.__FakeRuntime.sdk.createLoopingConditionContext = () => ({
		isStopped: false,
		uids: [],
		fields: [],
		retrigger() {
			const id = P.Exps.CurrentPlayerId.call(curInst);
			seenPlayers.push([id, P.Exps.PlayerName.call(curInst, id)]);
		},
		release() {}
	});
	curInst = inst4;
	P.Cnds.ForEachPlayer.call(inst4);
	globalThis.__FakeRuntime.sdk.createLoopingConditionContext = origMkLoop;
	assert.deepStrictEqual(seenPlayers, [[1, "me"], [2, "bob"]]);

	// he stops sending: his sprite is removed
	inst4.triggered.length = 0;
	w5.recv({ t: "player.props", id: 2, key: "_sf0", value: "" });
	assert.strictEqual(P.Exps.PlayerProxyUID.call(inst4, 2, "player"), 0);
	assert.ok(remote.destroyed, "the instance of player 2 must be destroyed");
	assert.ok(fired(inst4, "OnProxyDestroyed"));
	assert.strictEqual(P.Exps.EntityCount.call(inst4, "player"), 1);

	// GamePush-style values: scope "global" is the host scope, transform "full" is the same
	// mask as the older "everything"; both old spellings must keep working.
	P.Acts.SyncObject.call(inst4, Sprite, "crate", "global", "full", false, "");
	P.Acts.SyncObject.call(inst4, Sprite, "legacy", "host", "everything", true, "");
	const crate = inst4._defs.get("crate");
	const legacy = inst4._defs.get("legacy");
	assert.strictEqual(crate.scope, "host", "\"global\" must map to the host scope");
	assert.strictEqual(crate.interp, false);
	assert.strictEqual(legacy.scope, "host");
	assert.strictEqual(crate.mask, legacy.mask, "\"full\" and \"everything\" must be the same mask");
	assert.ok(crate.mask !== 0, "transform \"full\" must not be empty");

	// the same combo parameters given as indexes, which is what Construct passes at runtime
	P.Acts.SyncObject.call(inst4, Sprite, "idx", 0, 1, false, "");
	P.Acts.SyncObject.call(inst4, Sprite, "idx2", 1, 3, false, "");
	const idx1 = inst4._defs.get("idx");
	const idx2 = inst4._defs.get("idx2");
	assert.strictEqual(idx1.scope, "player", "scope index 0 is \"player\"");
	assert.strictEqual(idx1.mask, 1 | 2, "transform index 1 is \"position\" (x and y)");
	assert.strictEqual(idx2.scope, "host", "scope index 1 is \"global\", the host scope");
	assert.strictEqual(idx2.mask, crate.mask, "transform index 3 is \"full\"");

	// "Stop sync" also clears my data on the server
	P.Acts.StopSync.call(inst4);
	assert.strictEqual(P.Cnds.IsSyncing.call(inst4), false);
	sent = w5.sent[w5.sent.length - 1];
	assert.deepStrictEqual([sent.t, sent.key, sent.value], ["player.set", "_sf0", ""]);

	// ---- 4. object sync between two clients --------------------------------
	const mkClient = () => {
		const cls = new FakeObjectClass("Player");
		const crateCls = new FakeObjectClass("Crate");
		const rt = {
			byUid: new Map(),
			objects: { Player: cls, Crate: crateCls },
			layout: { getLayer: (n) => (n === 0 || n === "Game") ? { name: "Game" } : null },
			getInstanceByUid(uid) { return rt.byUid.get(uid) || null; },
			sdk: { createLoopingConditionContext: () => ({ isStopped: false, uids: [], fields: [], retrigger() {}, release() {} }) }
		};
		cls.rt = rt;
		crateCls.rt = rt;
		const inst = new P.Instance();
		inst.__runtime = rt;
		inst._retryBase = 5;
		return { inst: inst, rt: rt, cls: cls, crateCls: crateCls };
	};
	const joinClient = async (C, id, players) => {
		P.Acts.Connect.call(C.inst, "", "");
		await sleep(5);
		const ws = FakeWS.all[FakeWS.all.length - 1];
		ws.recv({ t: "welcome", userId: "u" + id, token: "t" + id, serverTime: Date.now(), proto: 1 });
		P.Acts.JoinOrCreateRoom.call(C.inst, "arena", 8, 30);
		ws.recv({ t: "room.joined", room: "arena", roomId: "r1", you: id, hostId: 1, maxPlayers: 8, players: players, state: {} });
		return ws;
	};
	const chunkOf = (ws) => ws.sent.filter((m) => m.t === "player.set" && m.key === "_sf0").pop();

	const A = mkClient();
	const B = mkClient();
	const wA = await joinClient(A, 1, [{ id: 1, name: "A", props: {} }]);
	const wB = await joinClient(B, 2, [{ id: 1, name: "A", props: {} }, { id: 2, name: "B", props: {} }]);

	const mineA = A.cls.createInstance("Game", 10, 20);
	const mineB = B.cls.createInstance("Game", 30, 40);

	// the same registration on both clients, then "Start auto-sync"
	P.Acts.SyncObject.call(A.inst, A.cls, "player", "player", "positionAngle", true, "Game");
	P.Acts.StartSync.call(A.inst);
	P.Acts.SyncObject.call(B.inst, B.cls, "player", "player", "positionAngle", true, "Game");
	P.Acts.StartSync.call(B.inst);
	assert.strictEqual(P.Exps.LocalEntityUID.call(A.inst, "player"), mineA.uid, "A must bind its own instance");
	assert.strictEqual(P.Exps.LocalEntityUID.call(B.inst, "player"), mineB.uid, "B must bind its own instance");

	// A moves: its state goes out as a player property
	mineA.x = 100; mineA.y = 200; mineA.angleDegrees = 45;
	A.inst._flush(performance.now());
	const chunkA = chunkOf(wA);
	assert.strictEqual(chunkA.value, '[[0,1035,100,200,45,"player"]]', "A must send its slot, fields and tag");

	// B receives it: a proxy of player 1 appears and moves to his position
	B.inst.triggered.length = 0;
	wB.recv({ t: "player.props", id: 1, key: "_sf0", value: chunkA.value });
	assert.ok(fired(B.inst, "OnProxyCreated"), "B must create a proxy for player 1");
	const proxyOnB = P.Exps.PlayerProxyUID.call(B.inst, 1, "player");
	assert.ok(proxyOnB > 0, "the proxy of player 1 must exist on B");
	const proxyInst = B.rt.getInstanceByUid(proxyOnB);
	assert.ok(proxyInst, "the proxy instance must be in B's runtime");
	B.inst._applyRemote(16);
	assert.deepStrictEqual([proxyInst.x, proxyInst.y, proxyInst.angleDegrees], [100, 200, 45]);
	assert.strictEqual(P.Exps.EntityCount.call(B.inst, "player"), 2, "B has its own object and the proxy");

	// smoothing really drives the interpolation: at 0 the state is applied at once, with
	// a value it is approached step by step
	P.Acts.SetSmoothing.call(B.inst, 0);
	wB.recv({ t: "player.props", id: 1, key: "_sf0", value: '[[0,1035,300,400,45,"player"]]' });
	B.inst._applyRemote(16);
	assert.deepStrictEqual([proxyInst.x, proxyInst.y], [300, 400], "smoothing 0 must apply the position at once");
	P.Acts.SetSmoothing.call(B.inst, 100);
	wB.recv({ t: "player.props", id: 1, key: "_sf0", value: '[[0,1035,400,500,45,"player"]]' });
	B.inst._applyRemote(16);
	assert.ok(proxyInst.x > 300 && proxyInst.x < 400,
		"smoothing 100 must approach the new position step by step, x = " + proxyInst.x);
	P.Acts.SetAutoSmoothing.call(B.inst);

	// and the other way round: B's state makes a proxy on A
	mineB.x = 7; mineB.y = 8; mineB.angleDegrees = 90;
	B.inst._flush(performance.now());
	A.inst.triggered.length = 0;
	wA.recv({ t: "player.props", id: 2, key: "_sf0", value: chunkOf(wB).value });
	assert.ok(fired(A.inst, "OnProxyCreated"), "A must create a proxy for player 2");
	A.inst._applyRemote(16);
	const proxyOnA = A.rt.getInstanceByUid(P.Exps.PlayerProxyUID.call(A.inst, 2, "player"));
	assert.deepStrictEqual([proxyOnA.x, proxyOnA.y], [7, 8]);

	// ---- 4b. instance variables ("Register object variable for sync") -------
	// The variable parameter is an index: the plugin resolves the name lazily from the
	// instance variables of the object type, exactly like GamePush.
	P.Acts.RegisterObjectVariable.call(A.inst, A.cls, "0", false);   // 0 = hp
	P.Acts.RegisterObjectVariable.call(B.inst, B.cls, "0", false);
	assert.strictEqual(A.inst._defs.get("player").varRefs[0].name, "hp", "index 0 must resolve to hp");
	mineA.instVars.hp = 30;
	A.inst._flush(performance.now());
	const chunkVars = chunkOf(wA);
	assert.ok(chunkVars.value.indexOf('{"hp":30}') > 0, "the chunk must carry hp: " + chunkVars.value);
	wB.recv({ t: "player.props", id: 1, key: "_sf0", value: chunkVars.value });
	B.inst._applyRemote(16);
	assert.strictEqual(proxyInst.instVars.hp, 30, "the proxy must receive hp");
	assert.strictEqual(proxyInst.instVars.ammo, 5, "variables that were not registered are untouched");

	// ---- 4c. global (host) scope gives entities, player scope gives proxies --
	P.Acts.SyncObject.call(A.inst, A.crateCls, "crate", "global", "position", false, "Game");
	P.Acts.SyncObject.call(B.inst, B.crateCls, "crate", "global", "position", false, "Game");
	P.Acts.StartSync.call(A.inst);
	P.Acts.StartSync.call(B.inst);
	const crateA = A.crateCls.createInstance("Game", 50, 60);
	A.inst._rebindAt = -1e9;
	A.inst._tick();
	assert.strictEqual(P.Exps.LocalEntityUID.call(A.inst, "crate"), crateA.uid, "the host binds its own crate");
	A.inst._flush(performance.now());
	const crateChunk = wA.sent.filter((m) => m.t === "player.set" && m.value && m.value.indexOf('"crate"') > 0).pop();
	assert.ok(crateChunk, "the host must send the crate");
	B.inst.triggered.length = 0;
	wB.recv({ t: "player.props", id: 1, key: crateChunk.key, value: crateChunk.value });
	assert.ok(fired(B.inst, "OnEntityCreated"), "a global object must fire \"On entity created\"");
	assert.ok(!fired(B.inst, "OnProxyCreated"), "a global object must not fire \"On player proxy created\"");
	const entityUid = P.Exps.PlayerProxyUID.call(B.inst, 1, "crate");
	B.inst._applyRemote(16);
	assert.deepStrictEqual([B.rt.getInstanceByUid(entityUid).x, B.rt.getInstanceByUid(entityUid).y], [50, 60]);

	// ---- 4d. the binding heals itself (layout change / late instance) -------
	const before = P.Exps.LocalEntityUID.call(A.inst, "player");
	mineA.destroy();
	const respawn = A.cls.createInstance("Game", 400, 500);
	A.inst._rebindAt = -1e9;
	A.inst._tick();
	assert.strictEqual(P.Exps.LocalEntityUID.call(A.inst, "player"), respawn.uid,
		"after the old instance is gone the sync must bind the new one by itself");
	assert.notStrictEqual(respawn.uid, before);
	respawn.x = 123;
	A.inst._flush(performance.now());
	assert.ok(chunkOf(wA).value.indexOf("123") > 0, "the new instance must be sent");

	// ---- 4e. "Start sync" before the room is entered (the usual event order) --
	// A game registers the object and starts the sync at "On start of layout" and
	// connects after that: the binding must move to the real player id once the room
	// is entered instead of staying on id 0 (which would stop the sync silently).
	const C = mkClient();
	const mineC = C.cls.createInstance("Game", 11, 22);
	P.Acts.SyncObject.call(C.inst, C.cls, "player", "player", "positionAngle", true, "Game");
	P.Acts.StartSync.call(C.inst);
	P.Acts.Connect.call(C.inst, "", "");
	await sleep(5);
	const wC = FakeWS.all[FakeWS.all.length - 1];
	wC.recv({ t: "welcome", userId: "uC", token: "tC", serverTime: Date.now(), proto: 1 });
	P.Acts.JoinOrCreateRoom.call(C.inst, "arena", 8, 30);
	wC.recv({ t: "room.joined", room: "arena", roomId: "r2", you: 1, hostId: 1, maxPlayers: 8, players: [{ id: 1, name: "C", props: {} }], state: {} });
	assert.strictEqual(P.Exps.LocalEntityUID.call(C.inst, "player"), mineC.uid, "the binding must survive the join");
	mineC.x = 500; mineC.y = 600;
	C.inst._flush(performance.now());
	const chunkC = chunkOf(wC);
	assert.ok(chunkC, "a sync started before joining a room must still send after the join");
	assert.ok(chunkC.value.indexOf("500") > 0, "the state must be sent under the real player id: " + chunkC.value);

	// ---- 4f. a player who is gone must not stay as a phantom ----------------
	// The room player list is the truth (GamePush does the same): if it does not contain
	// an owner any more, his objects are removed. That way a missed "player left" (a
	// reconnect, for example) cannot leave an object of a player who is no longer here.
	const D = mkClient();
	const E = mkClient();
	const wD = await joinClient(D, 1, [{ id: 1, name: "D", props: {} }]);
	const wE = await joinClient(E, 2, [{ id: 1, name: "D", props: {} }, { id: 2, name: "E", props: {} }]);
	const mineD = D.cls.createInstance("Game", 5, 5);
	P.Acts.SyncObject.call(D.inst, D.cls, "player", "player", "positionAngle", true, "Game");
	P.Acts.StartSync.call(D.inst);
	P.Acts.SyncObject.call(E.inst, E.cls, "player", "player", "positionAngle", true, "Game");
	P.Acts.StartSync.call(E.inst);
	mineD.x = 77; mineD.y = 88;
	D.inst._flush(performance.now());
	const chunkD = chunkOf(wD);
	assert.ok(chunkD, "D must send its state");
	wE.recv({ t: "player.props", id: 1, key: "_sf0", value: chunkD.value });
	assert.ok(P.Exps.PlayerProxyUID.call(E.inst, 1, "player") > 0, "E must have created the proxy of player 1");
	E.inst.triggered.length = 0;
	// E reconnects: the list of the room no longer contains player 1
	E.inst._onJoined({ room: "arena", roomId: "r1", you: 2, hostId: 2, maxPlayers: 8, players: [{ id: 2, name: "E", props: {} }], state: {} });
	assert.strictEqual(P.Exps.PlayerProxyUID.call(E.inst, 1, "player"), 0, "a player who is gone must not stay as a phantom");
	assert.ok(fired(E.inst, "OnProxyDestroyed"), "removing the phantom must fire \"On player proxy destroyed\"");

	// player 1 leaves: his proxy is removed on B (and fires "On player proxy destroyed")
	B.inst.triggered.length = 0;
	wB.recv({ t: "player.left", id: 1 });
	assert.ok(fired(B.inst, "OnProxyDestroyed"), "the proxy must be destroyed when the player leaves");
	assert.strictEqual(P.Exps.PlayerProxyUID.call(B.inst, 1, "player"), 0);

	// ---- 4g. nicknames at join and at leave ---------------------------------
	// The name travels inside the event itself: it must be readable inside the trigger
	// even when the player is already gone from the room list.
	const N = mkClient();
	const wN = await joinClient(N, 1, [{ id: 1, name: "Ann", props: {} }]);
	N.inst.triggered.length = 0;
	wN.recv({ t: "player.joined", player: { id: 2, name: "Bob", props: {} } });
	assert.ok(fired(N.inst, "OnPlayerJoined"));
	assert.strictEqual(P.Exps.LastPlayerName.call(N.inst), "Bob", "LastPlayerName must hold the joined player");
	assert.strictEqual(P.Exps.PlayerName.call(N.inst, P.Exps.LastPlayerId.call(N.inst)), "Bob");

	N.inst.triggered.length = 0;
	wN.recv({ t: "player.left", id: 2, name: "Bob" });
	assert.ok(fired(N.inst, "OnPlayerLeft"));
	assert.strictEqual(P.Exps.LastPlayerName.call(N.inst), "Bob", "LastPlayerName must hold the player who left");
	assert.strictEqual(P.Exps.PlayerName.call(N.inst, P.Exps.LastPlayerId.call(N.inst)), "Bob",
		"the name must stay readable after the player has been removed from the room");
	assert.strictEqual(N.inst._players.has(2), false, "a player who left must not stay in the room");

	// a player we never saw (joined and left while we were offline) still comes with a name
	N.inst.triggered.length = 0;
	wN.recv({ t: "player.left", id: 7, name: "Ghost" });
	assert.ok(fired(N.inst, "OnPlayerLeft"));
	assert.strictEqual(P.Exps.PlayerName.call(N.inst, P.Exps.LastPlayerId.call(N.inst)), "Ghost",
		"a player unknown to us must still give his name from player.left");

	// my own name goes out with room.join, so the other clients see it right away
	assert.strictEqual(wN.sent.filter((m) => m.t === "room.join").pop().name, "",
		"the join must carry a name field (empty until Set player name)");
	P.Acts.SetName.call(N.inst, "Nina");
	P.Acts.JoinOrCreateRoom.call(N.inst, "arena", 8, 30);
	assert.strictEqual(wN.sent.filter((m) => m.t === "room.join").pop().name, "Nina",
		"a name set before joining must go out with room.join");

	// ---- 5. batch: a server with welcome.batch gets one frame per flush ------
	const G = mkClient();
	P.Acts.Connect.call(G.inst, "", "");
	await sleep(5);
	const wG = FakeWS.all[FakeWS.all.length - 1];
	wG.recv({ t: "welcome", userId: "uG", token: "tG", serverTime: Date.now(), proto: 1, batch: true, maxString: 4096 });
	P.Acts.JoinOrCreateRoom.call(G.inst, "arena", 8, 30);
	wG.recv({ t: "room.joined", room: "arena", roomId: "r3", you: 1, hostId: 1, maxPlayers: 8, players: [{ id: 1, name: "G", props: {} }, { id: 2, name: "H", props: {} }], state: {} });
	assert.strictEqual(G.inst._chunkBytes, 4000, "the chunk size must follow welcome.maxString");
	// many synced objects: more than one old 1000-byte chunk, still one 4000-byte chunk
	for (let i = 0; i < 30; i++)
		G.cls.createInstance("Game", i * 10, i * 10);
	P.Acts.SyncObject.call(G.inst, G.cls, "player", "player", "full", true, "Game");
	P.Acts.StartSync.call(G.inst);
	G.inst._rebind();
	P.Acts.SetPlayerProp.call(G.inst, "color", "red");
	P.Acts.SetPlayerProp.call(G.inst, "team", 2);
	wG.sent.length = 0;
	G.inst._tokens = 20;
	G.inst._flush(performance.now());
	assert.strictEqual(wG.sent.length, 1, "one flush must leave as one frame: " + JSON.stringify(wG.sent.map((m) => m.t)));
	assert.strictEqual(wG.sent[0].t, "batch");
	const keys = wG.sent[0].items.map((m) => m.key);
	assert.ok(keys.includes("color") && keys.includes("team") && keys.includes("_sf0"), "the batch must carry props and chunks: " + keys);
	// an event right after a queued property keeps the order, in the same frame
	wG.sent.length = 0;
	P.Acts.SetPlayerProp.call(G.inst, "color", "blue");
	P.Acts.SendEvent.call(G.inst, 7, "boom", "all");
	assert.strictEqual(wG.sent.length, 1, "props + event must be one frame");
	assert.deepStrictEqual(wG.sent[0].items.map((m) => m.t), ["player.set", "event"]);
	// incoming batch: every item is dispatched, in order
	G.inst.triggered.length = 0;
	wG.recv({ t: "batch", items: [
		{ t: "player.props", id: 2, key: "color", value: "green" },
		{ t: "event", from: 2, code: 9, data: "hi" },
	] });
	assert.strictEqual(P.Exps.PlayerProp.call(G.inst, 2, "color"), "green", "a property inside a batch must be applied");
	assert.ok(fired(G.inst, "OnEvent"), "an event inside a batch must fire");

	// welcome.maxMsg: the plugin keeps its batches below the frame limit the server
	// accepts (a frame the server refuses to read closes the connection)
	assert.strictEqual(G.inst._batchBytes, 48 * 1024, "without maxMsg the plugin keeps its own cap");
	const GM = mkClient();
	assert.strictEqual(GM.inst._batchBytes, 48 * 1024, "the plugin starts with its own cap");
	P.Acts.Connect.call(GM.inst, "", "");
	await sleep(5);
	const wGM = FakeWS.all[FakeWS.all.length - 1];
	wGM.recv({ t: "welcome", userId: "uGM", token: "tGM", serverTime: Date.now(), proto: 1, batch: true, maxString: 4096, maxMsg: 1200 });
	P.Acts.JoinOrCreateRoom.call(GM.inst, "arena", 8, 30);
	wGM.recv({ t: "room.joined", room: "arena", roomId: "r5", you: 1, hostId: 1, maxPlayers: 8, players: [{ id: 1, name: "GM", props: {} }, { id: 2, name: "H", props: {} }], state: {} });
	assert.strictEqual(GM.inst._batchBytes, 1200 - 256, "the batch size must follow welcome.maxMsg");
	assert.ok(GM.inst._chunkBytes <= 1200 - 384, "one chunk must still fit into one frame: " + GM.inst._chunkBytes);
	for (let i = 0; i < 20; i++)
		GM.cls.createInstance("Game", i * 5, i * 5);
	P.Acts.SyncObject.call(GM.inst, GM.cls, "player", "player", "full", true, "Game");
	P.Acts.StartSync.call(GM.inst);
	GM.inst._rebind();
	P.Acts.SetPlayerProp.call(GM.inst, "color", "a".repeat(400));
	for (let i = 0; i < 5; i++)
		P.Acts.SetPlayerProp.call(GM.inst, "k" + i, "b".repeat(400));
	wGM.sent.length = 0;
	GM.inst._tokens = 20;
	GM.inst._flush(performance.now());
	assert.ok(wGM.sent.length > 1, "a small maxMsg must split one flush into several frames: " + wGM.sent.length);
	for (const m of wGM.sent)
		assert.ok(m.t !== "batch" || m.items.length >= 1, "every frame must carry something");

	// ---- 6. stage 2: the "sync" channel with snapshot interpolation ----------
	const joinSync = async (C, id, players) => {
		P.Acts.Connect.call(C.inst, "", "");
		await sleep(5);
		const ws = FakeWS.all[FakeWS.all.length - 1];
		ws.recv({ t: "welcome", userId: "s" + id, token: "s" + id, serverTime: Date.now(), proto: 1, batch: true, sync: true, maxSync: 32768, batchMs: 40 });
		P.Acts.JoinOrCreateRoom.call(C.inst, "arena", 8, 30);
		ws.recv({ t: "room.joined", room: "arena", roomId: "r4", you: id, hostId: 1, maxPlayers: 8, players: players, state: {} });
		return ws;
	};
	const S1 = mkClient();
	const S2 = mkClient();
	const wS1 = await joinSync(S1, 1, [{ id: 1, name: "S1", props: {} }]);
	const mineS = S1.cls.createInstance("Game", 10, 20);
	P.Acts.SyncObject.call(S1.inst, S1.cls, "player", "player", "positionAngle", true, "Game");
	P.Acts.StartSync.call(S1.inst);
	wS1.sent.length = 0;
	S1.inst._tokens = 20;
	S1.inst._flush(performance.now());
	const snap1 = wS1.sent.find((m) => m.t === "sync");
	assert.ok(snap1, "a sync server must get a \"sync\" message: " + JSON.stringify(wS1.sent));
	assert.ok(!wS1.sent.some((m) => m.t === "player.set"), "no _sf chunks on the sync channel");
	assert.deepStrictEqual(snap1.objs, [[0, 1035, 10, 20, 0, "player"]]);
	assert.ok(snap1.seq === 1 && snap1.ts > 0 && snap1.iv > 0, "a snapshot has seq, ts and iv");
	wS1.sent.length = 0;
	S1.inst._flush(performance.now());
	assert.strictEqual(wS1.sent.length, 0, "nothing changed: nothing is sent");
	mineS.x = 30;
	S1.inst._flush(performance.now());
	assert.strictEqual(wS1.sent[0].seq, 2, "a changed object gives the next snapshot");

	// the receiver: player 1 joined with his last snapshot, then two more arrive
	const wS2 = await joinSync(S2, 2, [{ id: 1, name: "S1", props: {}, sync: { seq: 1, ts: 1000, iv: 100, objs: [[0, 1035, 0, 0, 0, "player"]] } }, { id: 2, name: "S2", props: {} }]);
	P.Acts.SyncObject.call(S2.inst, S2.cls, "player", "player", "positionAngle", true, "Game");
	P.Acts.StartSync.call(S2.inst);
	let clock = 0;
	S2.inst._now = () => clock;
	clock = 10000; S2.inst._onSync(1, { seq: 1, ts: 1000, iv: 100, objs: [[0, 1035, 0, 0, 0, "player"]] }, true);
	clock = 10100; wS2.recv({ t: "sync", id: 1, seq: 2, ts: 1100, iv: 100, objs: [[0, 1035, 100, 50, 90, "player"]] });
	const proxyS = S2.rt.byUid.get(P.Exps.PlayerProxyUID.call(S2.inst, 1, "player"));
	assert.ok(proxyS, "the proxy of player 1 must exist");
	// the auto delay on a steady channel: 2 x the send interval (100) + the server
	// batching window (40) = 240 ms - the measured jitter is 0, so no extra margin
	assert.strictEqual(P.Exps.BufferDelay.call(S2.inst), 240, "a steady channel needs no extra delay");
	assert.strictEqual(P.Exps.Jitter.call(S2.inst), 0, "a steady channel has no jitter");
	assert.strictEqual(P.Exps.BufferSize.call(S2.inst), 2, "two snapshots are buffered");
	// delay = 240: at 10320 we draw 10080, 80% of the way between the snapshots
	clock = 10320; S2.inst._applyRemote(16);
	assert.ok(Math.abs(proxyS.x - 80) < 0.01 && Math.abs(proxyS.y - 40) < 0.01, "interpolated between the snapshots, got " + proxyS.x + "," + proxyS.y);
	assert.ok(Math.abs(proxyS.angleDegrees - 72) < 0.01, "the angle is interpolated too");
	// after a pause the object does not crawl across it: it waits, then moves over
	// one interval (the sender's clock went on, so a fresh offset is learned)
	clock = 15000; wS2.recv({ t: "sync", id: 1, seq: 3, ts: 6000, iv: 100, objs: [[0, 1035, 200, 50, 90, "player"]] });
	clock = 15000 + 240 - 100; S2.inst._applyRemote(16);
	assert.strictEqual(proxyS.x, 100, "the old position is held until one interval before the new snapshot");
	clock = 15000 + 240 - 50; S2.inst._applyRemote(16);
	assert.ok(Math.abs(proxyS.x - 150) < 0.01, "then it moves over one interval, got " + proxyS.x);
	// a hiccup: the snapshots stop - the object coasts on the last velocity instead of
	// freezing (a fresh buffer, as if the sender started over)
	clock = 20000; S2.inst._onSync(1, { seq: 1, ts: 1000, iv: 100, objs: [[0, 1035, 0, 0, 0, "player"]] }, true);
	clock = 20100; S2.inst._onSync(1, { seq: 2, ts: 1100, iv: 100, objs: [[0, 1035, 100, 50, 90, "player"]] }, false);
	clock = 20360; S2.inst._applyRemote(16);
	assert.ok(Math.abs(proxyS.x - 120) < 0.01, "past the newest snapshot the object coasts on, got " + proxyS.x);
	clock = 20450; S2.inst._applyRemote(16);
	assert.ok(Math.abs(proxyS.x - 210) < 0.01, "it coasts at the same speed, got " + proxyS.x);
	// ...but at most EXTRAP_MAX (250 ms) ahead: a lost connection must not fly it away
	for (clock = 20466; clock < 20600; clock += 16)
		S2.inst._applyRemote(16);
	assert.ok(Math.abs(proxyS.x - 350) < 1, "the coasting stops after 250 ms, got " + proxyS.x);
	// the measured jitter widens the delay at once and lets it down slowly
	const bufS = S2.inst._snaps.get(1);
	bufS.jit = 50;
	S2.inst._updateDelay(bufS);
	assert.strictEqual(P.Exps.BufferDelay.call(S2.inst), 390, "jitter widens the delay at once");
	bufS.jit = 0;
	S2.inst._updateDelay(bufS);
	assert.ok(bufS.delay > 360 && bufS.delay < 390, "the delay comes down slowly, got " + bufS.delay);
	// the correction after a gap is capped at 1.5x the entity's own speed
	const recS = S2.inst._sync.get("1:0");
	recS.gap = 250;
	recS.speed = 0.5;
	clock += 16;
	recS.tx = proxyS.x + 92; recS.ty = proxyS.y; recS.tt = clock - 16;	// 0.5 px/ms on the track
	const xBefore = proxyS.x;
	S2.inst._applyOne(proxyS, recS, { mask: 3, v: { x: proxyS.x + 100, y: proxyS.y } }, 16, true, clock);
	assert.ok(Math.abs(proxyS.x - xBefore - 12) < 0.01, "a catch-up may not run faster than 1.5x the entity speed, moved " + (proxyS.x - xBefore));
	// an empty snapshot removes the objects
	S2.inst.triggered.length = 0;
	wS2.recv({ t: "sync", id: 1, seq: 4, ts: 6100, iv: 100, objs: [] });
	assert.strictEqual(P.Exps.PlayerProxyUID.call(S2.inst, 1, "player"), 0, "an empty snapshot must remove the proxy");
	// stop sync on the sender: an empty snapshot goes out
	wS1.sent.length = 0;
	P.Acts.StopSync.call(S1.inst);
	assert.deepStrictEqual(wS1.sent.map((m) => [m.t, m.objs && m.objs.length]), [["sync", 0]], "stop sync must send an empty snapshot");

	// the expressions report what the buffers really do: the worst owner first, and
	// the plain smoothing target on a server without remote data (no "sync" snapshots)
	assert.strictEqual(Math.round(P.Exps.BufferDelay.call(S2.inst)), Math.round(S2.inst._snaps.get(1).delay),
		"BufferDelay reports the interpolation delay in use");
	assert.strictEqual(P.Exps.Smoothing.call(S1.inst), 107, "Smoothing without owners: the target for our own interval");

	// ---- clustered mode: the connection mode + the nearest region ---------------
	// A browser is the only one that knows which region is close to it, so the
	// plugin asks the directory for its regions, measures /health of each and sends
	// the nearest region in /assign. The "Connection mode" property forces one of
	// the two modes when the URL scheme cannot tell them apart.
	const calls = [];
	const realFetch = globalThis.fetch;
	const mk = (props) =>
	{
		class C extends P.Instance { _getInitProperties() { return props; } }
		return new C();
	};
	const okJson = (obj) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });

	// (a) https URL + auto mode: /regions, then the nearest one wins
	globalThis.fetch = (url, opts) =>
	{
		const u = String(url);
		calls.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
		if (u.endsWith("/regions"))
			return okJson({ regions: [{ region: "eu", url: "wss://eu.example.com/ws" },
				{ region: "us", url: "wss://us.example.com/ws" }] });
		if (u.endsWith("/assign"))
			return okJson({ url: "wss://us.example.com/ws", ticket: "TK", region: "us" });
		const ms = u.indexOf("us.example") >= 0 ? 4 : 60;		// "us" answers faster
		return new Promise((res) => setTimeout(() => res({ ok: true, status: 200, text: () => Promise.resolve("ok") }), ms));
	};
	FakeWS.all.length = 0;
	const dirInst = mk(["https://dir.example.com", "app1", 4, true, true, 2]);
	dirInst._retryBase = 5;
	P.Acts.Connect.call(dirInst, "", "");
	await sleep(150);
	const wsDir = FakeWS.all[FakeWS.all.length - 1];
	assert.ok(wsDir && wsDir.url.indexOf("wss://us.example.com/ws") === 0,
		"the nearest region must be used, got " + (wsDir && wsDir.url));
	const assignCall = calls.filter((c) => c.url.endsWith("/assign")).pop();
	assert.strictEqual(assignCall.body.region, "us", "/assign must carry the measured region");
	assert.strictEqual(assignCall.body.app, "app1");
	assert.ok(!calls.some((c) => c.url.endsWith("/assign") && c.body.region === "eu"), "the slow region must not be asked for");
	assert.strictEqual(P.Exps.Region.call(dirInst), "us", "the game must be able to read the region");
	assert.ok(FakeWS.all.length < 4, "regions are measured over http, not by opening sockets: " + FakeWS.all.length);

	// (b) a remembered region whose nodes are gone (HTTP 503) must not lock the game out
	globalThis.fetch = (url, opts) =>
	{
		const body = opts && opts.body ? JSON.parse(opts.body) : null;
		if (String(url).endsWith("/assign"))
			return body.region
				? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
				: okJson({ url: "wss://any.example.com/ws", ticket: "TK", region: "" });
		return okJson({ regions: [] });
	};
	FakeWS.all.length = 0;
	const pinInst = mk(["https://dir2.example.com", "app1", 4, true, true, 2]);
	pinInst._retryBase = 5;
	P.Acts.SetRegion.call(pinInst, "eu");					// the game pins a region
	assert.strictEqual(P.Exps.Region.call(pinInst), "eu");
	P.Acts.Connect.call(pinInst, "", "");
	await sleep(60);
	const wsAny = FakeWS.all[FakeWS.all.length - 1];
	assert.ok(wsAny && wsAny.url.indexOf("wss://any.example.com/ws") === 0,
		"a dead region must fall back to an unregioned assign, got " + (wsAny && wsAny.url));

	// (c) mode "node": an https URL is a game server, not a directory
	let nodeFetches = 0;
	globalThis.fetch = () => { nodeFetches++; return Promise.reject(new Error("no directory calls in node mode")); };
	FakeWS.all.length = 0;
	const nodeInst = mk(["https://node.example.com/ws", "app1", 4, true, true, 2, 1]);	// 1 = "node"
	nodeInst._retryBase = 5;
	P.Acts.Connect.call(nodeInst, "", "");
	await sleep(30);
	assert.strictEqual(nodeFetches, 0, "single-node mode must not call the directory");
	assert.strictEqual(FakeWS.all.length, 1, "exactly one socket, no probing");
	assert.ok(FakeWS.all[0].url.indexOf("wss://node.example.com/ws") === 0,
		"https:// must be spoken to as wss:// for a direct node: " + FakeWS.all[0].url);

	// (d) mode "directory": a wss:// URL is still the directory (http for its calls)
	const dirCalls = [];
	globalThis.fetch = (url, opts) =>
	{
		dirCalls.push(String(url));
		return String(url).endsWith("/regions")
			? okJson({ regions: [] })
			: okJson({ url: "wss://node7.example.com/ws", ticket: "TK", region: "eu" });
	};
	FakeWS.all.length = 0;
	const dirForced = mk(["wss://dir3.example.com", "app1", 4, true, true, 2, 2]);		// 2 = "directory"
	dirForced._retryBase = 5;
	P.Acts.Connect.call(dirForced, "", "");
	await sleep(40);
	assert.strictEqual(dirCalls[0], "https://dir3.example.com/regions",
		"a wss:// directory URL must be asked over https, got " + dirCalls[0]);
	assert.ok(dirCalls[1].indexOf("https://dir3.example.com/assign") === 0, dirCalls[1]);
	assert.ok(FakeWS.all.length === 1 && FakeWS.all[0].url.indexOf("wss://node7.example.com/ws") === 0);
	assert.strictEqual(P.Exps.Region.call(dirForced), "eu");
	globalThis.fetch = realFetch;

	console.log("Behaviour tests OK");
	process.exit(0);
})().catch((e) => { console.error("TEST FAILED:", e.message); process.exit(1); });
