"use strict";

{
	const C3 = globalThis.C3;

	C3.Plugins.StarkFlow.Acts =
	{
		Connect(url, token) { this._connect(url, token); },
		Disconnect() { this._disconnect(false); },
		SetAuthToken(token) { this._token = String(token); },
		SetName(name) { this._name = String(name); },

		JoinRoom(room) { this._join(room, false, 0, -1); },
		JoinOrCreateRoom(room, maxPlayers, emptyTTL) { this._join(room, true, maxPlayers, emptyTTL); },
		LeaveRoom() { this._leave(); },
		RequestRooms() { this._send({ t: "room.list", id: this._reqId() }); },

		SendEvent(code, data, to) { this._sendEvent(code, data, to); },

		SetState(key, value) { this._sendState("set", key, value); },
		SetStateBool(key, value) { this._sendState("set", key, !!value); },
		AddState(key, delta) { this._sendState("add", key, Number(delta)); },
		ToggleState(key) { this._sendState("toggle", key); },

		SetPlayerProp(key, value)
		{
			this._send({ t: "player.set", key: String(key), value: value });
		}
	};
}
