"use strict";

{
	const C3 = globalThis.C3;

	const PROTO_VERSION = 1;
	const LOG_LEVELS = ["debug", "info", "warn", "error", "off"];

	C3.Plugins.EwenLoy_StarkFlow.Instance = class StarkFlowInstance extends globalThis.ISDKInstanceBase
	{
		constructor()
		{
			super();

			// Properties, same order as in plugin.js (editor side).
			const props = this._getInitProperties() || [];
			this._url = props[0] || "ws://localhost:8080/ws";
			this._appId = props[1] || "default";
			this._logLevel = LOG_LEVELS[props[2]] || "info";
			this._autoReconnect = props[3] !== false;

			// Connection.
			this._ws = null;
			this._status = "disconnected";		// disconnected | connecting | connected | in-room | reconnecting
			this._token = "";
			this._userId = "";
			this._name = "";
			this._intentional = false;
			this._noReconnect = false;
			this._attempt = 0;
			this._maxAttempts = 10;
			this._retryBase = 1000;				// ms, doubled on every attempt
			this._retryMax = 8000;
			this._retryTimer = null;
			this._pingTimer = null;
			this._lastSend = 0;
			this._ping = 0;
			this._serverOffset = 0;
			this._nextReq = 0;
			this._lastJoin = null;				// replayed after a reconnect
			this._pendingCreate = null;			// "join or create": создаём, если комнаты нет

			// Room.
			this._roomId = "";
			this._roomName = "";
			this._myId = 0;
			this._hostId = 0;
			this._resumed = 0;
			this._players = new Map();
			this._state = new Map();
			this._roomList = [];

			// Values read by expressions inside triggers.
			this._lastPlayerId = 0;
			this._evCode = 0;
			this._evData = "";
			this._evFrom = 0;
			this._chKey = "";
			this._chValue = 0;
			this._chOld = 0;
			this._chBy = 0;
			this._ppKey = "";
			this._errCode = 0;
			this._errMsg = "";
		}

		_release()
		{
			this._disconnect(true);
			super._release();
		}

		// ---- helpers -------------------------------------------------

		_log(level, ...args)
		{
			const want = LOG_LEVELS.indexOf(this._logLevel);
			const have = LOG_LEVELS.indexOf(level);
			if (want < 0 || want >= LOG_LEVELS.length - 1 || have < want)
				return;
			const fn = level === "debug" ? "log" : level;
			console[fn]("[StarkFlow]", ...args);
		}

		_cnd(name)
		{
			return C3.Plugins.EwenLoy_StarkFlow.Cnds[name];
		}

		_buildUrl()
		{
			const sep = this._url.indexOf("?") >= 0 ? "&" : "?";
			return this._url + sep + "v=" + PROTO_VERSION + "&app=" + encodeURIComponent(this._appId);
		}

		_loadToken()
		{
			try
			{
				if (typeof localStorage !== "undefined")
					return localStorage.getItem("starkflow:" + this._appId + ":token") || "";
			}
			catch (e) { /* storage not available (worker mode, private mode) */ }
			return "";
		}

		_saveToken()
		{
			try
			{
				if (typeof localStorage !== "undefined")
				{
					const key = "starkflow:" + this._appId + ":token";
					if (this._token)
						localStorage.setItem(key, this._token);
					else
						localStorage.removeItem(key);
				}
			}
			catch (e) { /* ignore */ }
		}

		_reqId()
		{
			this._nextReq = (this._nextReq % 1000000000) + 1;
			return this._nextReq;
		}

		_clearRoom()
		{
			this._roomId = "";
			this._roomName = "";
			this._myId = 0;
			this._hostId = 0;
			this._players = new Map();
			this._state = new Map();
		}

		// ---- connection ----------------------------------------------

		_connect(url, token)
		{
			this._closeSocket();
			this._intentional = false;
			this._noReconnect = false;
			this._attempt = 0;
			if (url)
				this._url = url;
			if (token)
				this._token = token;
			else if (!this._token)
				this._token = this._loadToken();
			this._openSocket();
		}

		_openSocket()
		{
			this._status = this._attempt > 0 ? "reconnecting" : "connecting";
			let ws;
			try
			{
				ws = new WebSocket(this._buildUrl());
			}
			catch (e)
			{
				this._log("error", "cannot open WebSocket", e);
				this._ws = null;
				this._scheduleReconnect();
				return;
			}
			this._ws = ws;
			ws.onopen = () =>
			{
				if (this._ws !== ws) return;
				this._log("info", "socket open, sending hello");
				this._send({ t: "hello", token: this._token, name: this._name });
				this._startPing();
			};
			ws.onmessage = (ev) =>
			{
				if (this._ws !== ws) return;
				this._onMessage(ev.data);
			};
			ws.onclose = (ev) =>
			{
				if (this._ws !== ws) return;
				this._onClose(ev);
			};
			ws.onerror = () =>
			{
				// onclose always follows; nothing to do here
			};
		}

		_closeSocket()
		{
			this._stopPing();
			if (this._retryTimer)
			{
				clearTimeout(this._retryTimer);
				this._retryTimer = null;
			}
			const ws = this._ws;
			this._ws = null;			// makes the old handlers ignore everything
			if (ws)
			{
				try { ws.close(); } catch (e) { /* ignore */ }
			}
		}

		_disconnect(silent)
		{
			this._intentional = true;
			const wasOpen = this._status !== "disconnected";
			this._closeSocket();
			this._status = "disconnected";
			this._lastJoin = null;
			this._clearRoom();
			if (wasOpen && !silent)
				this._trigger(this._cnd("OnDisconnected"));
		}

		_onClose(ev)
		{
			this._stopPing();
			this._ws = null;
			if (!this._intentional && this._autoReconnect && !this._noReconnect)
			{
				this._log("warn", "connection lost (" + (ev && ev.code) + "), will retry");
				this._scheduleReconnect();
				return;
			}
			this._status = "disconnected";
			this._lastJoin = null;
			this._clearRoom();
			this._trigger(this._cnd("OnDisconnected"));
		}

		_scheduleReconnect()
		{
			this._attempt++;
			if (this._attempt > this._maxAttempts)
			{
				this._log("error", "giving up after " + this._maxAttempts + " attempts");
				this._status = "disconnected";
				this._lastJoin = null;
				this._clearRoom();
				this._trigger(this._cnd("OnDisconnected"));
				return;
			}
			this._status = "reconnecting";
			const delay = Math.min(this._retryBase * Math.pow(2, this._attempt - 1), this._retryMax);
			this._log("info", "reconnect attempt " + this._attempt + " in " + delay + " ms");
			this._trigger(this._cnd("OnReconnecting"));
			this._retryTimer = setTimeout(() =>
			{
				this._retryTimer = null;
				this._openSocket();
			}, delay);
		}

		_startPing()
		{
			this._stopPing();
			this._pingTimer = setInterval(() =>
			{
				if (this._ws && Date.now() - this._lastSend > 10000)
					this._send({ t: "ping", ts: Date.now() });
			}, 5000);
		}

		_stopPing()
		{
			if (this._pingTimer)
			{
				clearInterval(this._pingTimer);
				this._pingTimer = null;
			}
		}

		// ---- sending -------------------------------------------------

		_send(obj)
		{
			const ws = this._ws;
			if (!ws || ws.readyState !== 1)
			{
				this._log("warn", "not connected, message dropped:", obj.t);
				return false;
			}
			this._lastSend = Date.now();
			const text = JSON.stringify(obj);
			this._log("debug", "->", text);
			ws.send(text);
			return true;
		}

		_join(room, create, maxPlayers, emptyTTL)
		{
			const msg = { t: "room.join", room: String(room), create: create };
			if (maxPlayers > 0)
				msg.maxPlayers = Math.floor(maxPlayers);
			if (emptyTTL >= 0)
				msg.emptyTTL = Math.floor(emptyTTL);
			this._pendingCreate = null;
			if (create)
			{
				// Сервер при create=true всегда создаёт НОВУЮ комнату (одинаковые имена
				// разрешены), а нам нужно «войти, если есть, иначе создать»: сначала пробуем
				// войти по имени, и если такой комнаты нет (ошибка 300) — создаём.
				this._pendingCreate = msg;
				this._lastJoin = msg;
				this._send(Object.assign({ id: this._reqId() }, msg, { create: false }));
				return;
			}
			this._lastJoin = msg;
			this._send(Object.assign({ id: this._reqId() }, msg));
		}

		_leave()
		{
			this._lastJoin = null;
			this._pendingCreate = null;
			const wasIn = this._status === "in-room";
			this._send({ t: "room.leave", id: this._reqId() });
			if (wasIn)
			{
				this._status = "connected";
				this._clearRoom();
				this._trigger(this._cnd("OnLeftRoom"));
			}
		}

		_sendEvent(code, data, to)
		{
			const s = String(to === undefined || to === null ? "" : to).trim().toLowerCase();
			let target = "others";
			if (s === "all" || s === "others")
				target = s;
			else if (s !== "" && !isNaN(Number(s)))
				target = Number(s);
			this._send({ t: "event", code: Math.floor(Number(code)) || 0, data: String(data), to: target });
		}

		_sendState(op, key, value)
		{
			const msg = { t: "state." + op, key: String(key) };
			if (value !== undefined)
				msg.value = value;
			this._send(msg);
		}

		// ---- receiving -----------------------------------------------

		_onMessage(text)
		{
			let m;
			try { m = JSON.parse(text); }
			catch (e) { this._log("warn", "bad message from server"); return; }
			this._log("debug", "<-", text);

			switch (m.t)
			{
				case "welcome": this._onWelcome(m); break;
				case "room.joined": this._onJoined(m); break;
				case "player.joined": this._onPlayerJoined(m); break;
				case "player.left": this._onPlayerLeft(m); break;
				case "player.suspended": this._onPlayerStatus(m.id, "suspended", "OnPlayerSuspended"); break;
				case "player.resumed": this._onPlayerResumed(m); break;
				case "player.props": this._onPlayerProps(m); break;
				case "host.changed":
					this._hostId = m.hostId;
					this._trigger(this._cnd("OnHostChanged"));
					break;
				case "event": this._onEvent(m); break;
				case "state.changed": this._onStateChanged(m); break;
				case "room.list.result":
					this._roomList = Array.isArray(m.rooms) ? m.rooms : [];
					this._trigger(this._cnd("OnRoomList"));
					break;
				case "pong":
					this._ping = Math.max(0, Date.now() - (m.ts || Date.now()));
					break;
				case "err": this._onError(m); break;
				case "ok": break;
				default: this._log("debug", "unknown message type", m.t);
			}
		}

		_onWelcome(m)
		{
			this._userId = m.userId;
			this._token = m.token;
			this._saveToken();
			this._serverOffset = (m.serverTime || Date.now()) - Date.now();
			this._attempt = 0;
			this._status = this._lastJoin ? "reconnecting" : "connected";
			this._trigger(this._cnd("OnConnected"));
			if (this._lastJoin)
				this._send(Object.assign({ id: this._reqId() }, this._lastJoin));
		}

		_onJoined(m)
		{
			this._roomId = m.roomId || "";
			this._roomName = m.room;
			this._pendingCreate = null;
			// после обрыва возвращаемся по id: имена комнат не уникальны
			this._lastJoin = this._roomId ? { t: "room.join", room: this._roomId, create: false } : null;
			this._myId = m.you;
			this._hostId = m.hostId;
			this._resumed = m.resumed ? 1 : 0;
			this._players = new Map();
			for (const p of (m.players || []))
				this._players.set(p.id, p);
			this._state = new Map(Object.entries(m.state || {}));
			this._status = "in-room";
			this._trigger(this._cnd("OnJoinedRoom"));
		}

		_onPlayerJoined(m)
		{
			this._players.set(m.player.id, m.player);
			this._lastPlayerId = m.player.id;
			this._trigger(this._cnd("OnPlayerJoined"));
		}

		_onPlayerLeft(m)
		{
			this._players.delete(m.id);
			this._lastPlayerId = m.id;
			this._trigger(this._cnd("OnPlayerLeft"));
		}

		_onPlayerStatus(id, status, trigger)
		{
			const p = this._players.get(id);
			if (p)
				p.status = status;
			this._lastPlayerId = id;
			this._trigger(this._cnd(trigger));
		}

		_onPlayerResumed(m)
		{
			this._players.set(m.player.id, m.player);
			this._lastPlayerId = m.player.id;
			this._trigger(this._cnd("OnPlayerResumed"));
		}

		_onPlayerProps(m)
		{
			const p = this._players.get(m.id);
			if (p)
			{
				if (!p.props) p.props = {};
				p.props[m.key] = m.value;
			}
			this._lastPlayerId = m.id;
			this._ppKey = m.key;
			this._trigger(this._cnd("OnPlayerPropChanged"));
		}

		_onEvent(m)
		{
			this._evFrom = m.from;
			this._evCode = m.code;
			this._evData = typeof m.data === "string" ? m.data : (m.data === null || m.data === undefined ? "" : JSON.stringify(m.data));
			this._trigger(this._cnd("OnEvent"));
			this._trigger(this._cnd("OnAnyEvent"));
		}

		_onStateChanged(m)
		{
			this._state.set(m.key, m.value);
			this._chKey = m.key;
			this._chValue = m.value;
			this._chOld = m.old === null || m.old === undefined ? 0 : m.old;
			this._chBy = m.by;
			this._trigger(this._cnd("OnStateChanged"));
			this._trigger(this._cnd("OnAnyStateChanged"));
		}

		_onError(m)
		{
			this._errCode = m.code;
			this._errMsg = m.msg || "";
			this._log("warn", "server error", m.code, m.msg);
			if (m.code === 200)
			{
				// Token rejected (for example the server secret changed): forget it,
				// the automatic reconnect then gets a fresh identity.
				this._token = "";
				this._saveToken();
			}
			else if (m.code === 100)
			{
				this._noReconnect = true;		// protocol mismatch, retrying is pointless
			}
			else if (m.code === 300 && this._pendingCreate)
			{
				// комнаты с таким именем нет: создаём её (действие «войти или создать»)
				const msg = this._pendingCreate;
				this._pendingCreate = null;
				this._lastJoin = msg;
				this._send(Object.assign({ id: this._reqId() }, msg));
			}
			else if (m.code >= 300 && m.code < 400 && this._status !== "in-room")
			{
				this._lastJoin = null;			// join failed: do not replay it after a reconnect
				if (this._status === "reconnecting")
					this._status = "connected";
			}
			this._trigger(this._cnd("OnError"));
		}

		// ---- value helpers for expressions ----------------------------

		_plain(v)
		{
			if (typeof v === "boolean")
				return v ? 1 : 0;
			if (v === undefined || v === null)
				return 0;
			return v;
		}
	};
}
