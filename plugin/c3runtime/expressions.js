"use strict";

{
	const C3 = globalThis.C3;

	const num = (v) => (typeof v === "number" && isFinite(v)) ? v : 0;
	const round1 = (v) => Math.round(v * 10) / 10;
	const angleDeg = (inst) => typeof inst.angleDegrees === "number" ? inst.angleDegrees : (inst.angle || 0) * 180 / Math.PI;

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
		RoomId() { return this._roomId; },
		MyId() { return this._myId; },
		HostId() { return this._hostId; },
		Resumed() { return this._resumed; },
		RoomCount() { return this._roomList.length; },
		RoomListCount() { return this._roomList.length; },
		RoomPlayerCount() { return this._players.size; },
		RoomMaxPlayers() { return this._maxPlayers; },
		RoomNameAt(i) { const r = this._roomList[Math.floor(i)]; return r ? r.room : ""; },
		RoomIdAt(i) { const r = this._roomList[Math.floor(i)]; return r ? (r.id || "") : ""; },
		RoomPlayersAt(i) { const r = this._roomList[Math.floor(i)]; return r ? r.players : 0; },
		RoomMaxAt(i) { const r = this._roomList[Math.floor(i)]; return r ? r.maxPlayers : 0; },
		RoomFreeAt(i)
		{
			const r = this._roomList[Math.floor(i)];
			return r ? Math.max(0, (r.maxPlayers || 0) - (r.players || 0)) : 0;
		},
		RoomIsFullAt(i)
		{
			const r = this._roomList[Math.floor(i)];
			return r && r.players >= r.maxPlayers ? 1 : 0;
		},
		RoomLockedAt(i) { const r = this._roomList[Math.floor(i)]; return r && r.locked ? 1 : 0; },

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
		CurrentPlayerId() { return this._curPlayer; },
		ChangedPropKey() { return this._ppKey; },

		// object sync and send rate
		SendRate() { return this._sendHz; },
		SyncedObjectCount() { return this._sync.size; },

		// object sync: the simple API (inside "For each object" and its triggers)
		EntityUID() { return this._curEntity ? this._curEntity.uid : 0; },
		EntityTag() { return this._curEntity ? (this._curEntity.tag || "") : ""; },
		EntityOwner() { return this._curEntity ? this._curEntity.owner : 0; },
		EntityType() { return this._curEntity ? (this._curEntity.type || "") : ""; },
		EntitySlot() { return this._curEntity ? this._curEntity.slot : 0; },
		EntityCount(tag)
		{
			const want = String(tag === undefined || tag === null ? "" : tag);
			let n = 0;
			for (const rec of this._sync.values())
			{
				if (want === "" || rec.tag === want)
					n++;
			}
			return n;
		},
		EntityField(key)
		{
			const rec = this._curEntity;
			if (!rec)
				return "";
			const k = String(key === undefined || key === null ? "" : key);
			if (k === "uid") return rec.uid;
			if (k === "tag") return rec.tag || "";
			if (k === "owner") return rec.owner;
			if (k === "slot") return rec.slot;
			if (k === "type") return rec.type || "";
			const inst = this._instByUid(rec.uid);
			if (!inst)
				return "";
			switch (k)
			{
				case "x": return num(inst.x);
				case "y": return num(inst.y);
				case "z": return num(inst.zElevation);
				case "angle": return round1(angleDeg(inst));
				case "width": return num(inst.width);
				case "height": return num(inst.height);
				case "size": return num(inst.width);
				case "mirror": return inst.width < 0 ? 1 : 0;
				case "animation": return typeof inst.animationName === "string" ? inst.animationName : "";
				case "frame": return num(inst.animationFrame) | 0;
				case "visible": return inst.isVisible ? 1 : 0;
				case "opacity": return num(inst.opacity);
			}
			return "";
		},
		LocalEntityUID(tag)
		{
			const uid = this._bound.get(String(tag === undefined || tag === null || tag === "" ? "player" : tag));
			return uid === undefined ? 0 : uid;
		},
		PlayerProxyUID(playerId, tag)
		{
			const byTag = this._proxies.get(String(tag === undefined || tag === null || tag === "" ? "player" : tag));
			const uid = byTag ? byTag.get(Math.floor(Number(playerId)) || 0) : undefined;
			return uid === undefined ? 0 : uid;
		},
		ProxyPlayerId() { return this._curProxy ? this._curProxy.owner : 0; },
		ProxyTag() { return this._curProxy ? (this._curProxy.tag || "") : ""; },
		ProxyUID() { return this._curProxy ? this._curProxy.uid : 0; },

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
