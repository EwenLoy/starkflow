"use strict";

{
	const C3 = globalThis.C3;

	C3.Plugins.EwenLoy_StarkFlow.Cnds =
	{
		// connection
		OnConnected() { return true; },
		OnDisconnected() { return true; },
		OnReconnecting() { return true; },
		IsConnected() { return this._status === "connected" || this._status === "in-room"; },

		// room
		OnJoinedRoom() { return true; },
		OnLeftRoom() { return true; },
		OnRoomList() { return true; },
		IsInRoom() { return this._status === "in-room"; },
		IsHost() { return this._status === "in-room" && this._hostId === this._myId; },

		// players
		OnPlayerJoined() { return true; },
		OnPlayerLeft() { return true; },
		OnPlayerSuspended() { return true; },
		OnPlayerResumed() { return true; },
		OnHostChanged() { return true; },
		OnPlayerPropChanged(key) { return this._ppKey === String(key); },

		// events
		OnEvent(code) { return this._evCode === Math.floor(Number(code)); },
		OnAnyEvent() { return true; },

		// state
		OnStateChanged(key) { return this._chKey === String(key); },
		OnAnyStateChanged() { return true; },

		// errors
		OnError() { return true; }
	};
}
