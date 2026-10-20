"use strict";

{
	const C3 = globalThis.C3;

	C3.Plugins.EwenLoy_StarkFlow.Acts =
	{
		Connect(url, token) { this._connect(url, token); },
		Disconnect() { this._disconnect(false); },
		SetAuthToken(token) { this._token = String(token); },
		SetName(name) { this._name = String(name); },
		// Сколько секунд сервер держит место за игроком с оборванной связью
		// (0 — удалять сразу: остальные получают «On player left» в момент обрыва).
		// Действует на комнату, которую создаёт этот клиент.
		SetPlayerTimeout(seconds) { this._setPlayerTimeout(seconds); },
		// Clustered mode: pin the region ("eu", "ru", ...) or pass an empty string to
		// pick the nearest one automatically again (and measure it once more).
		SetRegion(region)
		{
			const r = String(region === undefined || region === null ? "" : region).trim();
			this._region = r;
			if (r === "")
				this._forgetRegion();
			else
				this._rememberRegion(r);
		},

		JoinRoom(room) { this._join(room, false, 0, -1, ""); },
		JoinOrCreateRoom(room, maxPlayers, emptyTTL) { this._join(room, true, maxPlayers, emptyTTL, ""); },
		JoinRoomWithPassword(room, password) { this._join(room, false, 0, -1, password); },
		JoinOrCreateRoomWithPassword(room, password, maxPlayers, emptyTTL) { this._join(room, true, maxPlayers, emptyTTL, password); },
		LeaveRoom() { this._leave(); },
		RequestRooms() { this._send({ t: "room.list", id: this._reqId() }); },

		SendEvent(code, data, to) { this._sendEvent(code, data, to); },

		SetState(key, value) { this._sendState("set", key, value); },
		SetStateBool(key, value) { this._sendState("set", key, !!value); },
		AddState(key, delta) { this._sendState("add", key, Number(delta)); },
		ToggleState(key) { this._sendState("toggle", key); },

		// Queued: the newest value of a key is sent at the send rate (see "Send rate").
		SetPlayerProp(key, value)
		{
			this._pendingProps.set(String(key), value);
		},

		// ---- object sync and send rate ----
		RegisterObject(obj, owner, slot, x, y, z, angle, size, mirror, anim, frame, visible, opacity)
		{
			let mask = 0;
			if (x) mask |= 1;
			if (y) mask |= 2;
			if (z) mask |= 4;
			if (angle) mask |= 8;
			if (size) mask |= 16;
			if (mirror) mask |= 32;
			if (anim) mask |= 64;
			if (frame) mask |= 128;
			if (visible) mask |= 256;
			if (opacity) mask |= 512;
			this._register(obj, owner, slot, mask);
		},
		UnregisterObject(obj) { this._unregister(obj); },
		// Manual smoothing time in ms ("Set smoothing"). 0 disables smoothing.
		SetSmoothing(ms) { this._smoothAuto = false; this._smoothMs = Math.max(0, Number(ms) || 0); },
		// Like the checkbox in the server test client: 1.4 x the send interval, 70..300 ms.
		SetAutoSmoothing() { this._smoothAuto = true; },
		// The "preset" combo arrives as the index of the item ("fast","medium","slow");
		// the item id is accepted too.
		SetSendRatePreset(preset)
		{
			const id = this._pickCombo(["fast", "medium", "slow"], preset, "medium");
			this._setSendRate({ fast: 58, medium: 30, slow: 15 }[id] || 30);
		},
		SetSendRateCustom(hz) { this._setSendRate(hz); },

		// ---- the simple object sync API ----
		SyncObject(obj, tag, scope, transform, interpolate, layer)
		{
			this._syncObject(obj, tag, scope, transform, interpolate, layer);
		},
		// GamePush: "Register object variable for sync" - an instance variable of a
		// registered object joins the sync (interpolate = smooth numeric changes).
		RegisterObjectVariable(obj, variable, interpolate)
		{
			this._registerObjectVariable(obj, variable, interpolate);
		},
		BindLocalInstance(obj) { this._bindLocalInstance(obj); },
		StartSync() { this._startSync(); },
		StopSync() { this._stopSync(); },

		// ---- room rules (used when this client creates a room) ----
		ClearRules() { this._rules = { strict: false, schema: {}, init: {} }; },
		SetStrict(on) { this._rules.strict = !!on; },
		AddKeyRule(key, kind, mode, min, max, maxDelta, reject) { this._ruleAdd(key, kind, mode, min, max, maxDelta, reject); },
		SetInitialValue(key, value) { this._ruleInit(key, value); }
	};
}
