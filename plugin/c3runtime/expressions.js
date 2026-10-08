"use strict";

{
	const C3 = globalThis.C3;

	C3.Plugins.EwenLoy_StarkFlow.Exps =
	{
		// connection
		AuthToken() { return this._token; },
		MyUserId() { return this._userId; },
		Ping() { return this._ping; },
		ServerTime() { return Date.now() + this._serverOffset; },
		StatusString() { return this._status; },

		// room
		RoomName() { return this._roomName; },
		MyId() { return this._myId; },
		HostId() { return this._hostId; },
		Resumed() { return this._resumed; },
		RoomCount() { return this._roomList.length; },
		RoomNameAt(i) { const r = this._roomList[Math.floor(i)]; return r ? r.room : ""; },
		RoomPlayersAt(i) { const r = this._roomList[Math.floor(i)]; return r ? r.players : 0; },
		RoomMaxAt(i) { const r = this._roomList[Math.floor(i)]; return r ? r.maxPlayers : 0; },

		// players
		PlayerCount() { return this._players.size; },
		PlayerIdAt(i)
		{
			const ids = Array.from(this._players.keys()).sort((a, b) => a - b);
			const id = ids[Math.floor(i)];
			return id === undefined ? 0 : id;
		},
		PlayerName(id) { const p = this._players.get(Math.floor(id)); return p ? (p.name || "") : ""; },
		PlayerUserId(id) { const p = this._players.get(Math.floor(id)); return p ? (p.userId || "") : ""; },
		PlayerStatus(id) { const p = this._players.get(Math.floor(id)); return p ? p.status : ""; },
		PlayerProp(id, key)
		{
			const p = this._players.get(Math.floor(id));
			return this._plain(p && p.props ? p.props[String(key)] : undefined);
		},
		LastPlayerId() { return this._lastPlayerId; },

		// events
		EventCode() { return this._evCode; },
		EventData() { return this._evData; },
		EventFrom() { return this._evFrom; },

		// state
		State(key) { return this._plain(this._state.get(String(key))); },
		ChangedKey() { return this._chKey; },
		ChangedValue() { return this._plain(this._chValue); },
		ChangedOld() { return this._plain(this._chOld); },
		ChangedBy() { return this._chBy; },

		// errors
		ErrorCode() { return this._errCode; },
		ErrorMsg() { return this._errMsg; }
	};
}
