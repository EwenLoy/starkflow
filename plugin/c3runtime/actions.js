"use strict";

{
	const C3 = globalThis.C3;

	C3.Plugins.EwenLoy_StarkFlow.Acts =
	{
		Connect(url, token) { this._connect(url, token); },
		Disconnect() { this._disconnect(false); },
		SetAuthToken(token) { this._token = String(token); },
		SetName(name) { this._name = String(name); },

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
		SetSmoothing(ms) { this._smoothMs = Math.max(0, Number(ms) || 0); },
		SetSendRatePreset(preset) { this._setSendRate([58, 30, 15][preset] || 30); },
		SetSendRateCustom(hz) { this._setSendRate(hz); },

		// ---- the simple object sync API ----
		SyncObject(obj, tag, scope, transform, interpolate, layer)
		{
			this._syncObject(obj, tag, scope, transform, interpolate, layer);
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
