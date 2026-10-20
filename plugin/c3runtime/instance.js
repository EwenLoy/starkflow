"use strict";

{
	const C3 = globalThis.C3;

	const PROTO_VERSION = 1;
	const LOG_LEVELS = ["debug", "info", "warn", "error", "off"];

	// ---- sending rate -------------------------------------------------
	// The server allows 60 messages/s per connection (and the ping etc. use some of
	// them), so the plugin never sends more than 58 sync messages per second.
	const MAX_RATE = 58;
	const PRESET_IDS = ["fast", "medium", "slow"];	// combo items of the "send rate" ACE/property
	const CONN_MODES = ["auto", "node", "directory"];	// combo items of the "connection mode" property
	const HZ_OF = { fast: 58, medium: 30, slow: 15 };
	const TOKEN_CAP = 20;				// short bursts are fine, the average stays under MAX_RATE

	// ---- object sync --------------------------------------------------
	// Synced objects are packed into the owner's player properties "_sf0".."_sf7".
	// The server tells its string limit in "welcome" (maxString, 4096 by default), a
	// chunk is a bit smaller than that; an old server without it allows 1024 bytes,
	// so the chunks are ~1000 bytes there. 8 chunks, the rest of the player
	// properties stay free for the game.
	const CHUNK_PREFIX = "_sf";
	const MAX_CHUNKS = 8;
	const CHUNK_BYTES = 1000;			// for a server that does not say its limit
	const CHUNK_BYTES_MAX = 6000;		// 8 chunks must fit into one batch frame

	// ---- batching -------------------------------------------------------
	// Messages queued during one sync flush leave as ONE WebSocket frame
	// {"t":"batch","items":[...]} if the server supports it (welcome.batch).
	const BATCH_MAX_ITEMS = 64;			// server limit per batch
	const BATCH_MAX_BYTES = 48 * 1024;	// below the server frame limit (64 KB)

	// ---- best region (clustered mode) -------------------------------------------
	// The directory may run several regions; the client measures the latency to one
	// node of each region and connects to the nearest one, remembering the result
	// (Photon's "best region"). Only the client can tell which region is close to
	// it: the directory itself sits in a single place.
	const REGION_TTL = 10 * 60 * 1000;	// how long a measured region is trusted
	const PROBE_TIMEOUT = 1500;			// ms per attempt to one region
	const PROBE_TRIES = 2;				// the second attempt rides the warm connection

	// ---- sync channel (stage 2) ----------------------------------------------
	// A server with welcome.sync gets the objects as numbered snapshots
	// {"t":"sync","seq","ts","iv","objs":[...]} instead of the "_sf" player properties.
	// The receiver keeps a short buffer of snapshots and draws other players a bit in
	// the past, interpolating between the two snapshots around that moment (entity
	// interpolation, G. Gambetta "Fast-Paced Multiplayer III").
	const SNAP_BUFFER = 64;				// snapshots kept per player
	const INTERP_MIN = 80;				// ms, auto interpolation delay is kept in 80..400
	const INTERP_MAX = 400;
	const EXTRAP_MAX = 250;				// ms of coasting on the last velocity when snapshots stop coming
	const BLEND_AFTER_GAP = 250;		// ms of easing back onto the sampled track after a gap
	const TELEPORT = 1000;				// px: a bigger jump is applied at once, without smoothing
	// A snapshot older than the newest one (lower seq) is late, not a restart of the
	// sender, if it is close in both seq and time: the unreliable channel reorders.
	const STALE_SEQ = SNAP_BUFFER;
	const STALE_MS = 2000;

	// ---- WebRTC (stage 4) -------------------------------------------------------
	// A server with welcome.rtc opens an unreliable, unordered DataChannel "sync"
	// next to the WebSocket (signaling goes over the WebSocket: rtc.offer/answer/ice).
	// Only the "sync" snapshots ride it — a lost one is simply skipped instead of
	// holding back everything behind it, as TCP does. Everything else, and the empty
	// "no objects any more" snapshot, stays on the WebSocket. No channel within
	// RTC_TIMEOUT, or the channel closed: sync goes over the WebSocket, as before.
	const RTC_TIMEOUT = 3000;
	const RTC_BUFFERED_MAX = 64 * 1024;	// more waiting in the channel = congested, use the WebSocket
	const RTC_ICE = [{ urls: "stun:stun.l.google.com:19302" }];	// when the server gives none
	const F = { X: 1, Y: 2, Z: 4, ANGLE: 8, SIZE: 16, MIRROR: 32, ANIM: 64, FRAME: 128, VISIBLE: 256, OPACITY: 512, TAG: 1024, VARS: 2048 };

	// ---- the simple object sync API ---------------------------------------
	// "Sync object" remembers what to sync (tag -> object type + fields), "Bind local
	// instance" says which instance is yours and "Start sync" starts sending it. For
	// every other player the plugin creates an instance of the same object type itself
	// and moves it, so a game needs only a few events (docs/GAME-GUIDE.md).
	const TRANSFORMS = {
		"none": 0,
		"position": F.X | F.Y,
		"positionAngle": F.X | F.Y | F.ANGLE,
		"full": F.X | F.Y | F.Z | F.ANGLE | F.SIZE | F.MIRROR | F.ANIM | F.FRAME | F.VISIBLE | F.OPACITY
	};
	TRANSFORMS.everything = TRANSFORMS.full;		// old name, still accepted
	// GamePush calls the scopes "player" and "global"; "host" is the same as "global".
	const TRANSFORM_IDS = ["none", "position", "positionAngle", "full"];
	const SCOPE_IDS = ["player", "global"];
	const SCOPES = { "player": "player", "global": "host", "host": "host" };
	const RULE_KINDS = ["num", "str", "bool"];
	const RULE_MODES = ["set", "add", "const", "once", "server"];

	const r1 = (v) => Math.round(v * 10) / 10;
	const r3 = (v) => Math.round(v * 1000) / 1000;
	const fin = (v) => (typeof v === "number" && isFinite(v)) ? v : 0;
	const utf8Len = (str) =>
	{
		let n = 0;
		for (let i = 0; i < str.length; i++)
		{
			const c = str.charCodeAt(i);
			n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xD800 && c < 0xDC00) ? (i++, 4) : 3;
		}
		return n;
	};
	const angleOf = (inst) => typeof inst.angleDegrees === "number" ? inst.angleDegrees : (inst.angle || 0) * 180 / Math.PI;

	C3.Plugins.EwenLoy_StarkFlow.Instance = class StarkFlowInstance extends globalThis.ISDKInstanceBase
	{
		constructor()
		{
			super();

			// Properties, same order as in plugin.js (editor side).
			const props = this._getInitProperties() || [];
			this._mode = this._pickCombo(CONN_MODES, props[6], "auto");
			this._url = this._normUrl(props[0] || "ws://localhost:8080/ws");
			this._appId = props[1] || "default";
			this._logLevel = this._pickCombo(LOG_LEVELS, props[2], "info");
			this._autoReconnect = props[3] !== false;
			this._replayPlayers = props[4] !== false;

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
			this._maxPlayers = 0;
			// "Set player timeout": сколько секунд сервер держит место за игроком
			// с оборванной связью. -1 — серверное значение (30 с), 0 — удалять
			// сразу, чтобы остальные получили «On player left» в момент обрыва.
			this._suspendTTL = -1;

			// Values read by expressions inside triggers.
			this._lastPlayerId = 0;
			this._lastPlayerName = "";
			this._evCode = 0;
			this._evData = "";
			this._evFrom = 0;
			this._chKey = "";
			this._chValue = 0;
			this._chOld = 0;
			this._chBy = 0;
			this._ppKey = "";
			this._curPlayer = 0;
			this._errCode = 0;
			this._errMsg = "";

			// Send rate: at most _sendHz sync flushes per second, and never more than
			// MAX_RATE messages per second (token bucket).
			this._sendHz = 30;
			this._sendInterval = 1000 / 30;
			this._setSendRate(HZ_OF[this._pickCombo(PRESET_IDS, props[5], "medium")] || 30, true);
			this._lastTick = 0;
			this._acc = 0;
			this._tokens = TOKEN_CAP;
			this._pendingProps = new Map();	// "Set player property" values waiting for the next flush
			this._sentProps = new Map();		// key -> JSON of the value the server already has

			// Object sync.
			this._smoothMs = 70;			// manual smoothing time in ms
			this._smoothAuto = true;		// auto: 1.4 x the send interval, 70..300 ms
			this._sync = new Map();			// "owner:slot" -> registered object
			this._net = new Map();				// owner id -> array of chunks, each a Map(slot -> state)
			this._sentChunks = [];
			this._chunkTime = [];
			this._warnedChunks = false;
			this._chunkBytes = CHUNK_BYTES;
			this._srvBatch = false;			// the server accepts and sends {"t":"batch"}
			this._outBatch = [];				// messages waiting for _flushOut
			this._batchBytes = BATCH_MAX_BYTES;	// welcome.maxMsg: size of one frame the server accepts
			this._srvSync = false;			// the server has the "sync" channel (welcome.sync)
			this._maxSync = 32 * 1024;		// welcome.maxSync: size of one snapshot
			this._srvBatchMs = 0;			// welcome.batchMs: the server batching window
			this._syncSeq = 0;				// number of our last snapshot
			this._syncLast = "";				// JSON of our last snapshot ("" = none sent)
			this._warnedSync = false;
			this._snaps = new Map();			// owner id -> { buf, off, seq, iv, jit, delay }
			this._statAt = 0;					// last "buffer:" diagnostics line
			this._region = "";					// pinned region ("" = pick automatically)
			this._curRegion = "";				// region we are connected to now
			this._probedDir = "";				// directory the last measurement belongs to
			this._probedAt = 0;
			this._probedRegion = "";
			this._rtcPc = null;				// RTCPeerConnection of the current socket
			this._rtcDc = null;				// the "sync" DataChannel, set only while open
			this._rtcTimer = null;
			this._rtcRemote = false;			// the answer is applied (candidates can be added)
			this._rtcIce = [];				// server candidates that came before the answer
			this._rtcMaxMsg = 0;			// largest message the channel takes
			this._rtcGaveUp = false;			// did not connect once: do not try again in this session
			this._rtcWarned = false;

			// The simple API: what to sync, what is mine, what belongs to other players.
			this._defs = new Map();			// tag -> definition (object type, fields, scope)
			this._defsByClass = new Map();	// object type name -> tags
			this._bound = new Map();		// tag -> uid of my own instance
			this._proxies = new Map();		// tag -> Map(owner player -> uid of the instance we created)
			this._proxyUid = new Map();		// uid -> { tag, owner, slot }
			this._tagSlots = new Map();		// "owner:tag" -> slot (mine only)
			this._nextSlot = 0;
			this._syncOn = false;			// "Start sync" was called
			this._curEntity = null;			// object in "For each object" and its triggers
			this._curProxy = null;			// object in "On player proxy / entity ..." triggers
			this._warnedProxy = false;
			this._varCache = new Map();		// object type name -> instance variable names
			this._rebindAt = -1e9;			// last time we re-checked the bindings (self-healing)

			// Room rules, sent when this client creates a room.
			this._rules = { strict: false, schema: {}, init: {} };

			this._setTicking(true);
		}

		_release()
		{
			this._disconnect(true);
			super._release();
		}

		// ---- helpers -------------------------------------------------

		// Construct hands a "combo" value over as the zero-based index of the chosen item
		// (that is also true for combo properties), but the item id itself is accepted as
		// well, so hand-written calls and older projects keep working.
		_pickCombo(ids, value, fallback)
		{
			if (value === undefined || value === null || value === "")
				return fallback;
			const n = Math.floor(Number(value));
			if (Number.isFinite(n) && String(n) === String(value).trim() && n >= 0 && n < ids.length)
				return ids[n];
			return String(value).trim();
		}

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
			this._maxPlayers = 0;
			this._dropProxies(true);
			this._sync.clear();
			this._net.clear();
			this._snaps.clear();
			this._syncLast = "";
			this._sentChunks = [];
			this._chunkTime = [];
			this._sentProps.clear();
			this._bound.clear();
			this._tagSlots.clear();
			this._curEntity = null;
			this._curProxy = null;
		}

		_now()
		{
			return performance.now();
		}

		// ---- connection ----------------------------------------------

		_connect(url, token)
		{
			this._closeSocket();
			this._intentional = false;
			this._noReconnect = false;
			this._attempt = 0;
			if (url)
				this._url = this._normUrl(url);
			if (token)
				this._token = token;
			else if (!this._token)
				this._token = this._loadToken();
			this._openSocket();
		}

		// ---- best region (clustered mode) ----------------------------

		_dirBase()
		{
			return this._url.replace(/\/*$/, "");
		}

		_regionKey()
		{
			return "starkflow:" + this._appId + ":region";
		}

		_forgetRegion()
		{
			this._probedDir = "";
			this._probedAt = 0;
			this._probedRegion = "";
			try
			{
				if (typeof localStorage !== "undefined")
					localStorage.removeItem(this._regionKey());
			}
			catch (e) { /* storage not available (worker mode, private mode) */ }
		}

		_cachedRegion()
		{
			try
			{
				if (typeof localStorage === "undefined")
					return "";
				const o = JSON.parse(localStorage.getItem(this._regionKey()) || "null");
				if (!o || typeof o.region !== "string" || !o.region)
					return "";
				if (!(Number(o.at) > 0) || Date.now() - Number(o.at) > REGION_TTL)
					return "";
				return o.region;
			}
			catch (e)
			{
				return "";
			}
		}

		_rememberRegion(region)
		{
			try
			{
				if (typeof localStorage !== "undefined")
					localStorage.setItem(this._regionKey(), JSON.stringify({ region: region, at: Date.now() }));
			}
			catch (e) { /* ignore */ }
		}

		// One HTTP round trip to a node of that region: /health answers "ok" and is
		// readable from another origin. The first attempt pays for TCP+TLS, the next
		// one rides the warm connection, so the minimum is close to the real RTT.
		_probeOnce(base, timeout)
		{
			const t0 = this._now();
			const opts = { cache: "no-store" };
			let timer = 0;
			try
			{
				if (typeof AbortController === "function")
				{
					const ctl = new AbortController();
					opts.signal = ctl.signal;
					timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* ignore */ } }, timeout);
				}
			}
			catch (e) { /* no AbortController: the fetch below is on its own */ }
			const done = () => { if (timer) clearTimeout(timer); };
			return fetch(base + "/health", opts)
				.then((res) => res.text())
				.then(() => { done(); return this._now() - t0; }, (err) => { done(); throw err; });
		}

		// ws(s)://node/ws -> http(s)://node (the /health probe endpoint)
		_probeBase(url)
		{
			return String(url).replace(/^ws/, "http").replace(/\/ws(\?.*)?$/, "").replace(/\/+$/, "");
		}

		_probeRegion(url)
		{
			const base = this._probeBase(url);
			const tries = [];
			for (let i = 0; i < PROBE_TRIES; i++)
				tries.push(this._probeOnce(base, PROBE_TIMEOUT));
			return Promise.all(tries).then((ms) => Math.min.apply(null, ms));
		}

		// Asks the directory for its regions, measures them and returns the nearest
		// one ("" when the directory has none or nothing answered: then the request
		// goes out without a region and the directory picks the least loaded node).
		_pickRegion(dirUrl)
		{
			if (dirUrl === this._probedDir && this._probedRegion && Date.now() - this._probedAt < REGION_TTL)
				return Promise.resolve(this._probedRegion);
			return fetch(dirUrl + "/regions", { cache: "no-store" })
				.then((res) => (res.ok ? res.json() : null), () => null)
				.then((data) =>
				{
					const list = (data && Array.isArray(data.regions)) ? data.regions : [];
					this._probedDir = dirUrl;
					this._probedAt = Date.now();
					this._probedRegion = "";
					if (!list.length)
						return "";
					if (list.length === 1)
						return String(list[0].region || "");
					return Promise.all(list.map((r) => this._probeRegion(r.url).then(
						(ms) => ({ region: String(r.region || ""), ms: ms }),
						() => null)))
						.then((all) =>
						{
							const ok = all.filter((x) => x && x.region && isFinite(x.ms));
							if (!ok.length)
								return "";
							ok.sort((a, b) => a.ms - b.ms);
							this._probedRegion = ok[0].region;
							this._log("info", "regions: " + ok.map((x) => x.region + " " + Math.round(x.ms) + "ms").join(", ") +
								" -> " + this._probedRegion);
							return this._probedRegion;
						});
				});
		}


		// Clustered mode: POST /assign {app, room?, region?} → {url, ticket, region}.
		// Then we connect to the node directly; the ticket rides in the query
		// string and is verified by the node. Every (re)connect re-asks the
		// directory, so drained or dead nodes drop out of rotation by themselves.
		_assignAndOpen()
		{
			this._status = this._attempt > 0 ? "reconnecting" : "connecting";
			const dirUrl = this._url.replace(/\/*$/, "");
			const room = (this._lastJoin && this._lastJoin.room) || "";
			const ask = (region) =>
			{
				this._log("info", "requesting a node from the directory", dirUrl, region ? "(region " + region + ")" : "");
				return fetch(dirUrl + "/assign", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ app: this._appId, room: String(room), region: region || "" })
				});
			};
			// null = the region we asked for has no live node any more
			const assign = (region) => ask(region).then((res) =>
			{
				if (res.ok)
					return res.json();
				if (region && res.status === 503)
					return null;
				throw new Error("directory /assign returned HTTP " + res.status);
			});
			// An explicit region wins, then the one measured earlier, then a fresh
			// measurement of every region the directory reports.
			const wanted = this._region || this._cachedRegion();
			const pick = wanted ? Promise.resolve(wanted) : this._pickRegion(dirUrl);
			pick.then((region) => assign(region).then((data) =>
			{
				if (data)
					return data;
				this._forgetRegion();			// the region is gone: ask without it
				return assign("");
			})).then((data) =>
			{
				if (this._intentional)
					return;					// отключились, пока directory отвечал
				const nodeUrl = String(data.url || "");
				const ticket = String(data.ticket || "");
				this._curRegion = String(data.region || "");
				if (!this._region && this._curRegion)
					this._rememberRegion(this._curRegion);
				if (!/^wss?:\/\//i.test(nodeUrl))
					throw new Error("directory returned a bad node url: " + JSON.stringify(data.url));
				// подключаемся напрямую к ноде: временно подменяем _url,
				// на реконнекте снова пойдём в directory
				const saved = this._url;
				this._url = nodeUrl + (nodeUrl.indexOf("?") >= 0 ? "&" : "?") +
					"ticket=" + encodeURIComponent(ticket);
				try
				{
					this._openSocket();
				}
				finally
				{
					this._url = saved;
				}
			}).catch((err) =>
			{
				if (this._intentional)
					return;
				this._log("error", "directory assign failed:",
					err && err.message ? err.message : err);
				this._scheduleReconnect();
			});
		}

		// "Connection mode" property: it decides how the Server URL is read, which
		// _normUrl turns into a scheme. By the time a socket is opened the scheme
		// alone says whether it is the cluster manager (http) or a game node (ws) —
		// the node we get from /assign arrives as ws and must not be re-assigned.
		_useDirectory()
		{
			return /^https?:\/\//i.test(this._url);
		}

		// The forced mode may need the other scheme: a directory is spoken to over
		// http(s) (fetch) and a node over ws(s). A URL without a scheme gets the one
		// of the mode (auto: a directory, the only thing an http address can be).
		_normUrl(url)
		{
			const u = String(url === undefined || url === null ? "" : url).trim();
			if (!u)
				return u;
			if (u.indexOf("://") < 0)
				return (this._mode === "node" ? "wss://" : "https://") + u;
			if (this._mode === "directory")
				return u.replace(/^ws/i, "http");		// wss://dir/  -> https://dir/
			if (this._mode === "node")
				return u.replace(/^http/i, "ws");		// https://node/ -> wss://node/
			return u;
		}

		_openSocket()
		{
			// Clustered mode: an http(s) Server URL is the directory, not a game
			// node. Ask it for a node (with a signed ticket) and connect there.
			if (this._useDirectory())
			{
				this._assignAndOpen();
				return;
			}
			this._status = this._attempt > 0 ? "reconnecting" : "connecting";
			const url = this._buildUrl();
			this._log("info", "connecting to", url);
			if (!/^wss?:\/\//i.test(this._url))
				this._log("error", "Server URL must start with ws:// or wss:// — got " + JSON.stringify(this._url));
			let ws;
			try
			{
				ws = new WebSocket(url);
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
				this._outBatch = [];
				this._srvBatch = false;			// until "welcome" says otherwise
				this._batchBytes = BATCH_MAX_BYTES;
				this._srvSync = false;
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
			this._rtcStop(false);
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
			this._rtcStop(false);
			this._ws = null;
			if (!this._intentional && this._autoReconnect && !this._noReconnect)
			{
				const why = ev && ev.code === 1006
					? " — nothing listening at that address (is the server running?)"
					: "";
				this._log("warn", "connection lost (" + (ev && ev.code) + "), will retry" + why);
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

		// _send sends right away; whatever is queued with _queue goes first, in the same frame.
		_send(obj)
		{
			if (this._outBatch.length)
			{
				this._outBatch.push(obj);
				return this._flushOut();
			}
			return this._sendRaw(obj);
		}

		// _queue holds a message until _flushOut (end of the sync flush) or the next _send.
		_queue(obj)
		{
			if (!this._srvBatch)
				return this._sendRaw(obj);
			this._outBatch.push(obj);
			return true;
		}

		// _flushOut sends the queued messages: one frame, or several if they are too big for one.
		_flushOut()
		{
			const items = this._outBatch;
			if (!items.length)
				return true;
			this._outBatch = [];
			let ok = true;
			let group = [], bytes = 0;
			const flush = () =>
			{
				if (group.length === 1)
					ok = this._sendRaw(group[0]) && ok;
				else if (group.length)
					ok = this._sendRaw({ t: "batch", items: group }) && ok;
				group = [];
				bytes = 0;
			};
			for (const it of items)
			{
				const b = JSON.stringify(it).length;
				if (group.length && (group.length >= BATCH_MAX_ITEMS || bytes + b > this._batchBytes))
					flush();
				group.push(it);
				bytes += b + 1;
			}
			flush();
			return ok;
		}

		_sendRaw(obj)
		{
			const ws = this._ws;
			if (!ws || ws.readyState !== 1)
			{
				this._log("warn", "not connected, message dropped:", obj.t);
				this._outBatch = [];
				return false;
			}
			this._lastSend = Date.now();
			const text = JSON.stringify(obj);
			this._log("debug", "->", text);
			ws.send(text);
			return true;
		}

		// ---- WebRTC channel for "sync" ---------------------------------

		// _sendUnreliable sends over the DataChannel if it is open and not congested;
		// false = the caller sends over the WebSocket instead.
		_sendUnreliable(obj)
		{
			const dc = this._rtcDc;
			if (!dc || dc.readyState !== "open" || dc.bufferedAmount > RTC_BUFFERED_MAX)
				return false;
			const text = JSON.stringify(obj);
			if (utf8Len(text) > this._rtcMaxMsg)
				return false;
			try { dc.send(text); }
			catch (e) { return false; }
			this._log("debug", "=>", text);
			return true;
		}

		// The client always makes the offer, the server only answers. Any failure
		// leaves the WebSocket path untouched.
		_rtcStart(m)
		{
			this._rtcStop(false);
			if (this._rtcGaveUp)
				return;
			if (typeof RTCPeerConnection !== "function")
			{
				if (!this._rtcWarned)
					this._log("info", "WebRTC is not available here (worker mode?), sync stays on the WebSocket");
				this._rtcWarned = true;
				return;
			}
			const ice = Array.isArray(m.iceServers) ? m.iceServers : RTC_ICE;
			let pc, dc;
			try
			{
				pc = new RTCPeerConnection({ iceServers: ice });
				dc = pc.createDataChannel("sync", { ordered: false, maxRetransmits: 0 });
			}
			catch (e)
			{
				this._log("warn", "cannot start WebRTC, sync stays on the WebSocket:", e);
				if (pc) { try { pc.close(); } catch (e2) { /* ignore */ } }
				return;
			}
			this._rtcPc = pc;
			this._rtcRemote = false;
			this._rtcIce = [];
			pc.onicecandidate = (ev) =>
			{
				if (this._rtcPc !== pc || !ev.candidate)
					return;
				this._send({ t: "rtc.ice", candidate: ev.candidate.toJSON() });
			};
			pc.onconnectionstatechange = () =>
			{
				if (this._rtcPc === pc && pc.connectionState === "failed")
				{
					this._log("warn", "WebRTC connection failed, sync goes over the WebSocket");
					this._rtcStop(true);
				}
			};
			dc.onopen = () =>
			{
				if (this._rtcPc !== pc)
					return;
				if (this._rtcTimer)
				{
					clearTimeout(this._rtcTimer);
					this._rtcTimer = null;
				}
				const mm = pc.sctp && pc.sctp.maxMessageSize;
				this._rtcMaxMsg = mm > 0 ? Math.min(mm, 256 * 1024) : 64 * 1024;
				this._rtcDc = dc;
				this._log("info", "sync goes over WebRTC");
			};
			dc.onclose = () =>
			{
				if (this._rtcDc !== dc)
					return;
				this._log("warn", "WebRTC channel closed, sync goes over the WebSocket");
				this._rtcStop(true);
			};
			dc.onmessage = (ev) =>
			{
				if (this._rtcPc === pc)
					this._onRtcMessage(ev.data);
			};
			this._rtcTimer = setTimeout(() =>
			{
				this._rtcTimer = null;
				if (this._rtcPc !== pc || this._rtcDc)
					return;
				this._log("info", "WebRTC did not connect in " + RTC_TIMEOUT + " ms, sync stays on the WebSocket");
				this._rtcGaveUp = true;
				this._rtcStop(true);
			}, RTC_TIMEOUT);
			pc.createOffer()
				.then((offer) => this._rtcPc === pc ? pc.setLocalDescription(offer) : null)
				.then(() =>
				{
					if (this._rtcPc === pc)
						this._send({ t: "rtc.offer", sdp: pc.localDescription.sdp });
				})
				.catch((e) =>
				{
					if (this._rtcPc !== pc)
						return;
					this._log("warn", "WebRTC offer failed, sync stays on the WebSocket:", e);
					this._rtcStop(true);
				});
		}

		// _rtcStop drops the channel; notify tells the server to drop its side as well.
		_rtcStop(notify)
		{
			if (this._rtcTimer)
			{
				clearTimeout(this._rtcTimer);
				this._rtcTimer = null;
			}
			const pc = this._rtcPc;
			this._rtcPc = null;			// makes the old handlers ignore everything
			this._rtcDc = null;
			this._rtcRemote = false;
			this._rtcIce = [];
			if (!pc)
				return;
			try { pc.close(); } catch (e) { /* ignore */ }
			if (notify && this._ws && this._ws.readyState === 1)
				this._send({ t: "rtc.close" });
		}

		_onRtcAnswer(m)
		{
			const pc = this._rtcPc;
			if (!pc || typeof m.sdp !== "string")
				return;
			pc.setRemoteDescription({ type: "answer", sdp: m.sdp })
				.then(() =>
				{
					if (this._rtcPc !== pc)
						return;
					this._rtcRemote = true;
					for (const c of this._rtcIce)
						pc.addIceCandidate(c).catch((e) => this._log("debug", "ICE candidate rejected:", e));
					this._rtcIce = [];
				})
				.catch((e) =>
				{
					if (this._rtcPc !== pc)
						return;
					this._log("warn", "bad WebRTC answer, sync stays on the WebSocket:", e);
					this._rtcStop(true);
				});
		}

		_onRtcIce(m)
		{
			const pc = this._rtcPc;
			if (!pc || !m.candidate || typeof m.candidate !== "object")
				return;
			if (!this._rtcRemote)
			{
				this._rtcIce.push(m.candidate);
				return;
			}
			pc.addIceCandidate(m.candidate).catch((e) => this._log("debug", "ICE candidate rejected:", e));
		}

		// Only "sync" is accepted from the DataChannel; a batch of them is unpacked.
		_onRtcMessage(data)
		{
			if (typeof data !== "string")
				return;
			let m;
			try { m = JSON.parse(data); }
			catch (e) { this._log("warn", "bad WebRTC message from server"); return; }
			this._log("debug", "<=", data);
			const list = (m && m.t === "batch" && Array.isArray(m.items)) ? m.items : [m];
			for (const it of list)
			{
				if (!it || it.t !== "sync")
					continue;
				try { this._onSync(it.id, it, false); }
				catch (e) { this._log("error", "failed to handle a WebRTC sync:", e); }
			}
		}

		_join(room, create, maxPlayers, emptyTTL, password)
		{
			const msg = { t: "room.join", room: String(room), create: create, name: this._name };
			if (maxPlayers > 0)
				msg.maxPlayers = Math.floor(maxPlayers);
			if (emptyTTL >= 0)
				msg.emptyTTL = Math.floor(emptyTTL);
			if (this._suspendTTL >= 0)
				msg.suspendTTL = Math.floor(this._suspendTTL);
			if (password)
				msg.password = String(password);
			this._pendingCreate = null;
			if (create)
			{
				// Сервер при create=true всегда создаёт НОВУЮ комнату (одинаковые имена
				// разрешены), а нам нужно «войти, если есть, иначе создать»: сначала пробуем
				// войти по имени, и если такой комнаты нет (ошибка 300) — создаём.
				// Правила комнаты (schema/strict/init) нужны только при создании.
				Object.assign(msg, this._rulesPayload());
				this._pendingCreate = msg;
				this._lastJoin = msg;
				const probe = Object.assign({ id: this._reqId() }, msg, { create: false });
				delete probe.schema;
				delete probe.strict;
				delete probe.init;
				this._send(probe);
				return;
			}
			this._lastJoin = msg;
			this._send(Object.assign({ id: this._reqId() }, msg));
		}

		_setPlayerTimeout(seconds)
		{
			const n = Math.floor(Number(seconds));
			this._suspendTTL = Number.isFinite(n) ? Math.max(-1, n) : -1;
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
				this._trigger(this._cnd("OnLeftRoom"));
				this._clearRoom();
			}
		}

		_sendEvent(code, data, to)
		{
			this._flushProps(true);		// keep the order: property changes made before the event go first
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

			// Разбор сообщения никогда не должен выбрасывать исключение наружу:
			// игра не увидит ни диалога, ни падения — только строку в консоли.
			// The server packs frequent messages into {"t":"batch","items":[...]}:
			// every item is handled on its own, one bad item does not stop the rest.
			const list = (m && m.t === "batch" && Array.isArray(m.items)) ? m.items : [m];
			for (const it of list)
			{
				try { this._dispatch(it); }
				catch (e) { this._log("error", "failed to handle the message " + (it && it.t) + ":", e); }
			}
		}

		_dispatch(m)
		{
			switch (m.t)
			{
				case "welcome": this._onWelcome(m); break;
				case "room.joined": this._onJoined(m); break;
				case "player.joined": this._onPlayerJoined(m); break;
				case "player.left": this._onPlayerLeft(m); break;
				case "player.suspended": this._onPlayerStatus(m.id, "suspended", "OnPlayerSuspended"); break;
				case "player.resumed": this._onPlayerResumed(m); break;
				case "player.props": this._onPlayerProps(m); break;
				case "sync": this._onSync(m.id, m, false); break;
				case "host.changed":
					this._hostId = m.hostId;
					this._trigger(this._cnd("OnHostChanged"));
					if (this._syncOn)
					{
						// Objects with the "global" (host) scope change hands
						for (const tag of Array.from(this._proxies.keys()))
						{
							const def = this._defs.get(tag);
							if (def && def.scope === "host")
								this._dropTag(tag, false);
						}
						this._rebind();
					}
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
				case "rtc.answer": this._onRtcAnswer(m); break;
				case "rtc.ice": this._onRtcIce(m); break;
				case "rtc.close": this._rtcStop(false); break;
				default: this._log("debug", "unknown message type", m.t);
			}
		}

		_onWelcome(m)
		{
			this._userId = m.userId;
			this._token = m.token;
			this._saveToken();
			this._serverOffset = (m.serverTime || Date.now()) - Date.now();
			this._srvBatch = m.batch === true;
			// The server knows its own frame limit: keep the batches below it (there is
			// no point in sending a frame the server would refuse to read). A short
			// guard is left for the batch wrapper itself.
			const maxMsg = Number(m.maxMsg);
			this._batchBytes = maxMsg > 0
				? Math.max(512, Math.min(BATCH_MAX_BYTES, maxMsg - 256))
				: BATCH_MAX_BYTES;
			const maxStr = Number(m.maxString);
			let chunk = maxStr > 0 ? Math.max(500, Math.min(CHUNK_BYTES_MAX, maxStr - 96)) : CHUNK_BYTES;
			chunk = Math.min(chunk, Math.max(256, this._batchBytes - 128));		// one chunk must fit into one frame
			this._chunkBytes = chunk;
			this._srvSync = m.sync === true;
			if (Number(m.maxSync) > 0)
				this._maxSync = Number(m.maxSync);
			this._srvBatchMs = Math.max(0, Number(m.batchMs) || 0);
			// started right away, not on join: ICE has time while the game gets going
			if (m.rtc === true && this._srvSync)
				this._rtcStart(m);
			else
				this._rtcStop(false);
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
			this._lastJoin = this._roomId ? { t: "room.join", room: this._roomId, create: false, name: this._name } : null;
			if (this._lastJoin && this._suspendTTL >= 0)
				this._lastJoin.suspendTTL = Math.floor(this._suspendTTL);
			this._myId = m.you;
			this._hostId = m.hostId;
			this._maxPlayers = m.maxPlayers || 0;
			this._resumed = m.resumed ? 1 : 0;
			this._players = new Map();
			this._net.clear();
			this._snaps.clear();
			this._syncLast = "";				// send our snapshot again in the new room
			this._sentChunks = [];
			this._chunkTime = [];
			this._sentProps.clear();
			for (const p of (m.players || []))
			{
				this._players.set(p.id, p);
				this._ingestAll(p);
			}
			// Initialize state from server: m.state contains initial values set by room creator
			this._state = new Map(Object.entries(m.state || {}));
			this._log("info", "joined room, received state:", JSON.stringify(m.state));
			this._status = "in-room";
			this._trigger(this._cnd("OnJoinedRoom"));

			// Trigger "On state changed" for each initial state value so the game can react
			for (const [key, value] of this._state.entries())
			{
				this._chKey = key;
				this._chValue = value;
				this._chOld = 0;
				this._chBy = 0;
				this._trigger(this._cnd("OnStateChanged"));
				this._trigger(this._cnd("OnAnyStateChanged"));
			}

			// Players that were in the room before us: fire "On player joined" for each
			// (including ourselves), so one event can create all player objects.
			// Not after a resume: the game already has those objects.
			if (this._replayPlayers && !m.resumed)
			{
				const ids = Array.from(this._players.keys()).sort((a, b) => a - b);
				for (const id of ids)
				{
					const p = this._players.get(id);
					if (!p)
						continue;
					this._lastPlayerId = id;
					this._lastPlayerName = p.name || "";
					this._trigger(this._cnd("OnPlayerJoined"));
				}
			}
			if (this._syncOn)
			{
				// Returning after a lost connection: the objects are still there, only
				// the binding has to be checked again.
				this._rebind();
				// Players who left while we were away are not in the list any more, so
				// their objects have to go as well (no phantoms after a reconnect).
				this._pruneOwners(this._players.keys());
			}
		}

		_onPlayerJoined(m)
		{
			this._players.set(m.player.id, m.player);
			this._ingestAll(m.player);
			this._lastPlayerId = m.player.id;
			this._lastPlayerName = m.player.name || "";
			this._trigger(this._cnd("OnPlayerJoined"));
		}

		_onPlayerLeft(m)
		{
			const p = this._players.get(m.id);
			// Имя приходит и в самом player.left: ушедшего могло не быть в списке
			// (вошёл и вышел, пока мы были offline), а после trigger его уже нет.
			const name = (typeof m.name === "string" && m.name !== "") ? m.name : (p ? (p.name || "") : "");
			if (p && name !== "" && !p.name)
				p.name = name;
			this._lastPlayerId = m.id;
			this._lastPlayerName = name;
			this._trigger(this._cnd("OnPlayerLeft"));
			this._players.delete(m.id);
			this._net.delete(m.id);
			this._snaps.delete(m.id);
			this._dropOwner(m.id);
		}

		_onPlayerStatus(id, status, trigger)
		{
			const p = this._players.get(id);
			if (p)
				p.status = status;
			this._lastPlayerId = id;
			this._lastPlayerName = p ? (p.name || "") : "";
			this._trigger(this._cnd(trigger));
		}

		_onPlayerResumed(m)
		{
			this._players.set(m.player.id, m.player);
			this._ingestAll(m.player);
			this._lastPlayerId = m.player.id;
			this._lastPlayerName = m.player.name || "";
			this._trigger(this._cnd("OnPlayerResumed"));
		}

		_onPlayerProps(m)
		{
			if (typeof m.key === "string" && m.key.startsWith(CHUNK_PREFIX))
			{
				this._ingest(m.id, m.key, m.value);	// object sync data, not a game property
				return;
			}
			const p = this._players.get(m.id);
			if (p)
			{
				if (!p.props) p.props = {};
				p.props[m.key] = m.value;
			}
			this._lastPlayerId = m.id;
			this._ppKey = m.key;
			this._trigger(this._cnd("OnPlayerPropChanged"));
			this._trigger(this._cnd("OnAnyPlayerPropChanged"));
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
			// Настоящие ошибки всегда уходят в консоль с уровнем "error" — их не
			// отфильтровывает даже "Log level = error". Ложный 300 от пробного входа
			// «войти или создать» остаётся на уровне "warn".
			const probe = m.code === 300 && !!this._pendingCreate;
			this._log(probe ? "warn" : "error", "server error", m.code, m.msg);
			if (m.code === 500)
				this._trigger(this._cnd("OnRateLimited"));
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
			else if (probe)
			{
				// комнаты с таким именем нет: создаём её (действие «войти или создать»).
				// Это ожидаемая ветка, а не сбой: пробный room.join намеренно уходит с
				// create=false и обязан получить 300. Дальше создаётся комната и повторный
				// вход успешен, поэтому On error здесь не срабатывает — иначе игра показала
				// бы ложное «комната не найдена» посреди нормального входа. Остаётся только
				// строка в логе (см. this._log выше).
				const msg = this._pendingCreate;
				this._pendingCreate = null;
				this._lastJoin = msg;
				delete msg.schema;
				delete msg.strict;
				delete msg.init;
				Object.assign(msg, this._rulesPayload());
				this._send(Object.assign({ id: this._reqId() }, msg));
				return;
			}
			else if (m.code >= 300 && m.code < 400 && this._status !== "in-room")
			{
				this._lastJoin = null;			// join failed: do not replay it after a reconnect
				if (this._status === "reconnecting")
					this._status = "connected";
			}
			this._trigger(this._cnd("OnError"));
		}

		// ---- send rate and the tick ----------------------------------

		// hz is clamped to 1..58. "60" is accepted too and means "as fast as allowed".
		_setSendRate(hz, quiet)
		{
			hz = Math.round(Number(hz));
			if (!isFinite(hz))
				hz = 30;
			hz = Math.max(1, Math.min(MAX_RATE, hz));
			this._sendHz = hz;
			this._sendInterval = 1000 / hz;
			if (!quiet)
				this._log("info", "send rate: " + hz + "/s");
		}

		// Smoothing of other players' objects. "Auto" follows the send interval, exactly
		// like the test client on the server does: 1.4 x the interval, kept in 70..300 ms.
		_autoSmoothMs()
		{
			return Math.max(70, Math.min(300, Math.round(this._sendInterval * 1.4)));
		}

		_smoothValue()
		{
			return this._smoothAuto ? this._autoSmoothMs() : this._smoothMs;
		}

		_tick()
		{
			// Тик вызывает движок Construct: исключение отсюда вылезло бы в превью
			// как ошибка JS, поэтому всё уходит в консоль (не чаще раза в секунду).
			try { this._tickInner(); }
			catch (e)
			{
				const now = this._now();
				if (!this._tickErrAt || now - this._tickErrAt > 1000)
				{
					this._tickErrAt = now;
					this._log("error", "sync tick failed:", e);
				}
			}
		}

		_tickInner()
		{
			const now = this._now();
			const dt = this._lastTick ? Math.min(100, Math.max(0, now - this._lastTick)) : 0;
			this._lastTick = now;
			this._tokens = Math.min(TOKEN_CAP, this._tokens + dt * MAX_RATE / 1000);

			// self-healing: the bound instance may be gone (layout change, respawn) or may
			// appear only after "Start sync" - check the bindings twice a second
			if (this._syncOn && this._defs.size && now - this._rebindAt > 500)
			{
				this._rebindAt = now;
				this._rebind();
				// The room player list is the truth: an owner who is not in it any more
				// must not keep his objects (a missed "player left" would leave a phantom).
				if (this._players.size)
					this._pruneOwners(this._players.keys());
			}

			if (this._sync.size)
				this._applyRemote(dt);

			// Diagnostics: one line every 5 s at the debug level, to tell what the
			// smoothness is limited by - a small buffer with a big jitter means the
			// delay must grow, an empty buffer means a burst it did not cover.
			if (this._snaps.size && now - this._statAt > 5000)
			{
				this._statAt = now;
				this._log("debug", "buffer: delay " + Math.round(this._bufferDelay()) + " ms, " +
					this._bufferSize() + " snapshot(s), jitter " + Math.round(this._jitter()) +
					" ms, ping " + Math.round(this._ping) + " ms, smoothing " + Math.round(this._smoothValue()) + " ms");
			}

			this._acc += dt;
			if (this._acc < this._sendInterval)
				return;
			this._acc = Math.min(this._acc - this._sendInterval, this._sendInterval);
			this._flush(now);
		}

		_canSend()
		{
			return this._status === "in-room" && this._ws && this._ws.readyState === 1;
		}

		// Player properties set with "Set player property" are queued: the newest value of
		// a key wins and goes out at the send rate. force = send everything now.
		_flushProps(force)
		{
			if (!this._pendingProps.size || !this._canSend())
				return;
			for (const [key, value] of this._pendingProps)
			{
				if (!force && this._tokens < 1)
					return;
				this._pendingProps.delete(key);
				const sig = JSON.stringify(value);
				if (this._sentProps.get(key) === sig)
					continue;				// the server already has this value
				this._sentProps.set(key, sig);
				this._tokens = Math.max(0, this._tokens - 1);
				this._queue({ t: "player.set", key: key, value: value });
			}
		}

		_flush(now)
		{
			if (!this._canSend())
				return;
			this._flushProps(false);
			if (this._srvSync)
			{
				if (this._sync.size || this._syncLast)
					this._flushSyncChannel(now);
			}
			else if (this._sync.size || this._sentChunks.length)
				this._flushSync(now);
			this._flushOut();			// everything of this flush leaves as one frame
		}

		// ---- object sync: sending ------------------------------------

		_resolve(rec)
		{
			const inst = this._instByUid(rec.uid);
			if (!inst)
			{
				this._sync.delete(rec.key);		// the object was destroyed
				return null;
			}
			return inst;
		}

		_encode(inst, rec)
		{
			return JSON.stringify(this._encodeArr(inst, rec));
		}

		_encodeArr(inst, rec)
		{
			const f = rec.mask | (rec.tag ? F.TAG : 0);
			const a = [rec.slot, f];
			if (f & F.X) a.push(r1(fin(inst.x)));
			if (f & F.Y) a.push(r1(fin(inst.y)));
			if (f & F.Z) a.push(r1(fin(inst.zElevation)));
			if (f & F.ANGLE) a.push(r1(fin(angleOf(inst))));
			if (f & F.SIZE) { a.push(r1(fin(inst.width))); a.push(r1(fin(inst.height))); }
			if (f & F.MIRROR) a.push(inst.width < 0 ? 1 : 0);
			if (f & F.ANIM) a.push(typeof inst.animationName === "string" ? inst.animationName.slice(0, 64) : "");
			if (f & F.FRAME) a.push(fin(inst.animationFrame) | 0);
			if (f & F.VISIBLE) a.push(inst.isVisible ? 1 : 0);
			if (f & F.OPACITY) a.push(Math.round(fin(inst.opacity) * 100) / 100);
			if (f & F.TAG) a.push(rec.tag);
			const vars = rec.vars || null;
			if (vars && vars.length && inst.instVars)
			{
				const obj = {};
				let any = false;
				for (const v of vars)
				{
					const val = inst.instVars[v.name];
					if (val === undefined || val === null)
						continue;
					obj[v.name] = (typeof val === "number" && isFinite(val)) ? (v.interp ? r3(val) : val) : val;
					any = true;
				}
				if (any)
				{
					a[1] = f | F.VARS;
					a.push(obj);
				}
			}
			return a;
		}

		// Stage 2: all our objects as one numbered snapshot, sent only when something
		// changed. ts is our clock: the receivers use the time between snapshots, not
		// the absolute value, so the clocks of the players do not have to match.
		_flushSyncChannel(now)
		{
			const mine = [];
			for (const rec of this._sync.values())
			{
				if (rec.owner !== this._myId)
					continue;
				const inst = this._resolve(rec);
				if (inst)
					mine.push(this._encodeArr(inst, rec));
			}
			mine.sort((a, b) => a[0] - b[0]);
			if (!mine.length && !this._syncLast)
				return;
			let text = JSON.stringify(mine);
			if (utf8Len(text) > this._maxSync)
			{
				if (!this._warnedSync)
					this._log("warn", "too many synced objects: a snapshot is limited to " + this._maxSync + " bytes, the last objects are not sent");
				this._warnedSync = true;
				while (mine.length && utf8Len(text) > this._maxSync)
				{
					mine.pop();
					text = JSON.stringify(mine);
				}
			}
			if (text === this._syncLast || (!mine.length && this._syncLast === ""))
				return;
			if (this._tokens < 1)
				return;
			this._tokens--;
			this._syncLast = mine.length ? text : "";
			const msg = { t: "sync", seq: ++this._syncSeq, ts: Math.round(now), iv: Math.round(this._sendInterval), objs: mine };
			// the empty snapshot removes our objects for the others: it must not get lost
			if (!mine.length || !this._sendUnreliable(msg))
				this._queue(msg);
		}

		_flushSync(now)
		{
			const mine = [];
			for (const rec of this._sync.values())
			{
				if (rec.owner !== this._myId)
					continue;
				const inst = this._resolve(rec);
				if (inst)
					mine.push({ slot: rec.slot, str: this._encode(inst, rec) });
			}
			mine.sort((a, b) => a.slot - b.slot);

			// pack records into chunks that fit into one player property
			const chunks = [];
			let cur = [], bytes = 2;
			for (const r of mine)
			{
				const b = utf8Len(r.str) + 1;
				if (cur.length && bytes + b > this._chunkBytes)
				{
					chunks.push("[" + cur.join(",") + "]");
					cur = [];
					bytes = 2;
				}
				cur.push(r.str);
				bytes += b;
			}
			if (cur.length)
				chunks.push("[" + cur.join(",") + "]");
			if (chunks.length > MAX_CHUNKS)
			{
				if (!this._warnedChunks)
					this._log("warn", "too many synced objects: only the first " + MAX_CHUNKS + " chunks (~" + MAX_CHUNKS * this._chunkBytes + " bytes) are sent");
				this._warnedChunks = true;
				chunks.length = MAX_CHUNKS;
			}

			// send only the chunks that changed, the longest-unsent first
			const todo = [];
			const n = Math.max(chunks.length, this._sentChunks.length);
			for (let i = 0; i < n; i++)
			{
				const want = i < chunks.length ? chunks[i] : "";
				const had = this._sentChunks[i];
				if (had === want || (had === undefined && want === ""))
					continue;
				todo.push(i);
			}
			todo.sort((a, b) => (this._chunkTime[a] || 0) - (this._chunkTime[b] || 0));
			for (const i of todo)
			{
				if (this._tokens < 1)
					break;
				const want = i < chunks.length ? chunks[i] : "";
				this._tokens--;
				this._sentChunks[i] = want;
				this._chunkTime[i] = now;
				this._queue({ t: "player.set", key: CHUNK_PREFIX + i, value: want });
			}
		}

		// ---- object sync: receiving ----------------------------------

		_ingestAll(player)
		{
			if (!player)
				return;
			if (player.props)
			{
				for (const k of Object.keys(player.props))
				{
					if (k.startsWith(CHUNK_PREFIX))
						this._ingest(player.id, k, player.props[k]);
				}
			}
			if (player.sync)
				this._onSync(player.id, player.sync, true);	// the last snapshot, for newcomers
		}

		// A snapshot of another player's objects arrived ("sync" or players[].sync).
		_onSync(owner, s, reset)
		{
			if (!s || owner === this._myId || !Array.isArray(s.objs))
				return;
			const states = this._decodeRecords(s.objs);
			const now = this._now();
			const ts = fin(s.ts), seq = fin(s.seq);
			let o = this._snaps.get(owner);
			// A late snapshot (the unreliable channel reorders, and a switch between the
			// WebSocket and WebRTC can too) is dropped: a newer one is already in the buffer.
			const newest = o && o.buf[o.buf.length - 1];
			if (o && !reset && newest && seq <= o.seq && o.seq - seq <= STALE_SEQ && newest.ts - ts >= 0 && newest.ts - ts <= STALE_MS)
				return;
			// a new buffer: first snapshot, a resume, or the sender started again (seq went back)
			if (!o || reset || seq <= o.seq)
			{
				o = { buf: [], off: undefined, seq: 0, iv: 0, jit: 0, arr: undefined, ts: undefined, delay: undefined };
				this._snaps.set(owner, o);
			}
			// Clock offset sender -> us: the smallest "arrival - ts" seen is the fastest
			// delivery; it follows slow drift, and a big jump means a new clock.
			const off = now - ts;
			if (o.off === undefined || off < o.off || off - o.off > 1000)
				o.off = off;
			else
				o.off += (off - o.off) * 0.01;
			o.iv = fin(s.iv) > 0 ? fin(s.iv) : this._sendInterval;
			// Jitter (RFC 3550): how much the arrival spacing deviates from the send
			// spacing. A steady latency gives 0 here even when it is a second long -
			// only the unevenness of the channel has to be absorbed by the buffer.
			// A pause (the sender stopped for a while) is not unevenness: skip it.
			if (o.arr !== undefined && ts - o.ts <= (o.iv || 0) * 4)
			{
				const d = (now - o.arr) - (ts - o.ts);
				o.jit += (Math.abs(d) - o.jit) * 0.0625;	// EMA 1/16, like RTP
				if (o.jit > 4000)
					o.jit = 4000;
			}
			o.arr = now;
			o.ts = ts;
			o.seq = seq;
			this._updateDelay(o);
			// The owner sends only changes: after a pause the previous position is held
			// until one interval before the new one, so the object does not crawl across the pause.
			const last = o.buf[o.buf.length - 1];
			if (last && ts - last.ts > o.iv * 2.5)
				o.buf.push({ ts: ts - o.iv, states: last.states });
			o.buf.push({ ts: ts, states: states });
			if (o.buf.length > SNAP_BUFFER)
				o.buf.splice(0, o.buf.length - SNAP_BUFFER);

			this._net.set(owner, [states]);		// the newest snapshot: creating/removing objects
			if (this._syncOn)
			{
				this._adopt(owner);
				this._pruneProxies(owner);
			}
		}

		// How far in the past other players are drawn. Auto: a jitter buffer - one
		// send interval of the owner plus three measured jitters and the server
		// batching window (see _delayTarget), measured on real arrivals. Manual
		// "Set smoothing" overrides it.
		_interpDelay(o)
		{
			if (!this._smoothAuto)
				return this._smoothMs;
			if (o && o.delay !== undefined)
				return o.delay;
			return this._delayTarget(o);
		}

		// The delay the buffer should have now: two send intervals (one to receive the
		// next snapshot, one to interpolate into) plus three measured jitters and the
		// server batching window - enough to cover a burst, not more (every extra
		// millisecond is a millisecond the player sees in the past).
		_delayTarget(o)
		{
			const iv = o && o.iv > 0 ? o.iv : this._sendInterval;
			const jit = o && o.jit > 0 ? o.jit : 0;
			return Math.max(INTERP_MIN, Math.min(INTERP_MAX, Math.round(iv * 2 + jit * 3 + this._srvBatchMs)));
		}

		// Called once per arrived snapshot: the delay jumps up at once (a burst must
		// not empty the buffer) and comes down slowly (~1 s time constant), so a
		// short lull above the average does not yank the drawn moment forward.
		_updateDelay(o)
		{
			const want = this._delayTarget(o);
			if (o.delay === undefined || want > o.delay)
				o.delay = want;
			else
				o.delay += (want - o.delay) * (1 - Math.exp(-(o.iv || this._sendInterval) / 1000));
			o.delay = Math.max(INTERP_MIN, Math.min(INTERP_MAX, o.delay));
		}

		// Diagnostics of the buffers, worst owner first: the largest delay in use, the
		// smallest buffer (the closest to running dry) and the largest jitter. Like
		// GamePush's MultiplayerBufferDelay / MultiplayerBufferSize / NetworkPing.
		_bufferDelay()
		{
			let max = 0;
			for (const o of this._snaps.values())
			{
				const d = this._interpDelay(o);
				if (d > max)
					max = d;
			}
			return max || this._interpDelay(null);
		}

		_bufferSize()
		{
			let min = -1;
			for (const o of this._snaps.values())
			{
				if (min < 0 || o.buf.length < min)
					min = o.buf.length;
			}
			return min < 0 ? 0 : min;
		}

		_jitter()
		{
			let max = 0;
			for (const o of this._snaps.values())
			{
				if ((o.jit || 0) > max)
					max = o.jit;
			}
			return max;
		}

		// The state of one object at the moment t (our clock), between two snapshots.
		// Past the newest one it coasts on the last velocity for EXTRAP_MAX ms
		// (extrapolation) instead of freezing: that is what keeps a player moving
		// through a network hiccup, and the flag "ex" tells _applyOne to glide back
		// when fresh data is there again.
		_sample(o, rec, t)
		{
			const buf = o.buf;
			if (!buf.length)
				return null;
			const at = (i) => buf[i].ts + o.off;
			let i = buf.length - 1;
			while (i > 0 && at(i) > t)
				i--;
			if (i > 1)
			{
				buf.splice(0, i - 1);			// older snapshots are not needed any more
				i = 1;
			}
			const a = buf[i].states.get(rec.slot);
			if (!a)
				return null;
			if (at(i) > t)
				return a;						// before the oldest snapshot: hold it
			if (i === buf.length - 1)
			{
				// past the newest: coast on the last velocity
				const over = t - at(i);
				const span = i > 0 ? at(i) - at(i - 1) : 0;
				return this._extrapolate(i > 0 ? buf[i - 1].states.get(rec.slot) : null, a, over, span, rec,
					over >= (o.iv || 0));
			}
			const b = buf[i + 1].states.get(rec.slot);
			if (!b)
				return a;
			const span = at(i + 1) - at(i);
			return this._lerpState(a, b, span > 0 ? (t - at(i)) / span : 1, rec);
		}

		// Continue the movement of the last two snapshots. over = ms since the newest
		// snapshot, span = ms between those two. Nothing is sent during a pause, so
		// over stays 0 for a standing player: only a moving one coasts. mark says the
		// coasting has outgrown one interval - a real gap that _applyOne has to glide
		// back from; the usual edge of the buffer is not one.
		_extrapolate(prev, cur, over, span, rec, mark)
		{
			if (!prev || over <= 0 || span <= 0)
				return cur;
			let held = false;
			if (over > EXTRAP_MAX)
			{
				over = EXTRAP_MAX;			// hold the coasted position, do not fly away
				held = true;				// a hold is not a gap any more
			}
			const pa = prev.v, cb = cur.v;
			if (Math.abs(fin(cb.x) - fin(pa.x)) > TELEPORT || Math.abs(fin(cb.y) - fin(pa.y)) > TELEPORT)
				return cur;						// a jump: no flying across the map
			const f = over / span;
			const v = Object.assign({}, cb);	// animation, frame, visibility: the newest
			for (const key of ["x", "y", "z", "op"])
			{
				if (typeof pa[key] === "number" && typeof cb[key] === "number")
					v[key] = cb[key] + (cb[key] - pa[key]) * f;
			}
			if (typeof pa.a === "number" && typeof cb.a === "number")
			{
				const d = ((cb.a - pa.a + 540) % 360 + 360) % 360 - 180;	// shortest way round
				v.a = cb.a + d * f;
			}
			if (pa.vars && cb.vars && rec.vars && rec.vars.length)
			{
				v.vars = Object.assign({}, cb.vars);
				for (const def of rec.vars)
				{
					const x = pa.vars[def.name], y = cb.vars[def.name];
					if (def.interp && typeof x === "number" && typeof y === "number")
						v.vars[def.name] = y + (y - x) * f;
				}
			}
			// A hold keeps the gap flag: the object sits ahead of the fresh track and
			// _applyOne glides it back once data returns.
			const out = { mask: cur.mask, v: v };
			if (mark && !held)
				out.ex = over;
			else if (held)
				out.hold = true;
			return out;
		}

		_lerpState(a, b, k, rec)
		{
			if (k <= 0)
				return a;
			if (k >= 1)
				return b;
			const va = a.v, vb = b.v;
			if (Math.abs(fin(vb.x) - fin(va.x)) > TELEPORT || Math.abs(fin(vb.y) - fin(va.y)) > TELEPORT)
				return b;						// a jump: no flying across the map
			const v = Object.assign({}, va);	// animation, frame, visibility: the older snapshot
			for (const f of ["x", "y", "z", "w", "h", "op"])
			{
				if (typeof va[f] === "number" && typeof vb[f] === "number")
					v[f] = va[f] + (vb[f] - va[f]) * k;
			}
			if (typeof va.a === "number" && typeof vb.a === "number")
			{
				const d = ((vb.a - va.a + 540) % 360 + 360) % 360 - 180;	// shortest way round
				v.a = va.a + d * k;
			}
			if (va.vars && vb.vars && rec.vars && rec.vars.length)
			{
				v.vars = Object.assign({}, va.vars);
				for (const def of rec.vars)
				{
					const x = va.vars[def.name], y = vb.vars[def.name];
					if (def.interp && typeof x === "number" && typeof y === "number")
						v.vars[def.name] = x + (y - x) * k;
				}
			}
			return { mask: a.mask, v: v };
		}

		_ingest(owner, key, value)
		{
			if (owner === this._myId)
				return;							// our own data coming back
			const idx = parseInt(key.slice(CHUNK_PREFIX.length), 10);
			if (!(idx >= 0 && idx < MAX_CHUNKS))
				return;
			let chunks = this._net.get(owner);
			if (!chunks)
			{
				chunks = [];
				this._net.set(owner, chunks);
			}
			chunks[idx] = this._decodeChunk(value);
			if (this._syncOn)
			{
				this._adopt(owner);
				this._pruneProxies(owner);
			}
		}

		_decodeChunk(str)
		{
			const out = new Map();
			if (typeof str !== "string" || str === "")
				return out;
			let arr;
			try { arr = JSON.parse(str); }
			catch (e) { return out; }
			return this._decodeRecords(arr);
		}

		// records: [[slot, flags, ...values], ...] -> Map(slot -> {mask, v})
		_decodeRecords(arr)
		{
			const out = new Map();
			if (!Array.isArray(arr))
				return out;
			for (const r of arr)
			{
				if (!Array.isArray(r))
					continue;
				let i = 0;
				const slot = fin(r[i++]) | 0;
				const f = fin(r[i++]) | 0;
				const v = {};
				if (f & F.X) v.x = fin(r[i++]);
				if (f & F.Y) v.y = fin(r[i++]);
				if (f & F.Z) v.z = fin(r[i++]);
				if (f & F.ANGLE) v.a = fin(r[i++]);
				if (f & F.SIZE) { v.w = fin(r[i++]); v.h = fin(r[i++]); }
				if (f & F.MIRROR) v.mir = fin(r[i++]) ? 1 : 0;
				if (f & F.ANIM) v.anim = String(r[i++] === undefined ? "" : r[i - 1]);
				if (f & F.FRAME) v.frame = fin(r[i++]) | 0;
				if (f & F.VISIBLE) v.vis = fin(r[i++]) ? 1 : 0;
				if (f & F.OPACITY) v.op = fin(r[i++]);
				if (f & F.TAG)
				{
					const t = r[i++];
					v.tag = typeof t === "string" ? t : "";
				}
				if (f & F.VARS)
				{
					const o = r[i++];
					v.vars = (o && typeof o === "object") ? o : null;
				}
				out.set(slot, { mask: f, v: v });
			}
			return out;
		}

		_getNet(owner, slot)
		{
			const chunks = this._net.get(owner);
			if (!chunks)
				return null;
			for (const c of chunks)
			{
				const st = c && c.get(slot);
				if (st)
					return st;
			}
			return null;
		}

		_applyRemote(dt)
		{
			const now = this._now();
			for (const rec of this._sync.values())
			{
				if (rec.owner === this._myId)
					continue;
				const o = this._snaps.get(rec.owner);
				const delay = o ? this._interpDelay(o) : 0;
				if (o && delay > 0 && rec.interp !== false)
				{
					const sst = this._sample(o, rec, now - delay);
					const sinst = sst ? this._resolve(rec) : null;
					if (sinst)
						this._applyOne(sinst, rec, sst, dt, true, now);
					continue;
				}
				const st = this._getNet(rec.owner, rec.slot);
				if (!st)
					continue;
				const inst = this._resolve(rec);
				if (!inst)
					continue;
				this._applyOne(inst, rec, st, dt);
			}
		}

		// exact: st is already interpolated (the sync channel), apply it as is.
		_applyOne(inst, rec, st, dt, exact, now)
		{
			const v = st.v, m = st.mask;
			const smoothMs = this._smoothValue();
			const raw = !rec.seen || smoothMs <= 0 || rec.interp === false;
			rec.seen = true;
			const t = now === undefined ? this._now() : now;

			// The speed of the entity itself, taken from the track the interpolator
			// moves along (px/ms). It limits how fast a correction is allowed to run.
			let speed = rec.speed || 0;
			if (rec.tt !== undefined && t > rec.tt && typeof v.x === "number" && typeof rec.tx === "number")
			{
				const sp = Math.hypot(fin(v.x) - rec.tx, fin(v.y) - rec.ty) / (t - rec.tt);
				if (isFinite(sp))
					speed += (sp - speed) * 0.3;
			}
			if (typeof v.x === "number")
			{
				rec.tx = fin(v.x);
				rec.ty = fin(v.y);
				rec.tt = t;
				rec.speed = speed;
			}

			// Fresh data after an extrapolation: the drawn object may sit a bit ahead
			// of the fresh track. Glide back over BLEND_AFTER_GAP, never faster than
			// 1.5x the entity's own speed (Rune's maxSpeed), so no jump and no rubber
			// band; the flag is cleared once it is back on the track.
			if (exact)
			{
				if (st.ex)
					rec.gap = BLEND_AFTER_GAP;			// a gap: glide back once data is fresh
				else if (!st.hold && rec.gap > 0)
				{
					if (Math.abs(fin(v.x) - fin(inst.x)) < 1 && Math.abs(fin(v.y) - fin(inst.y)) < 1)
						rec.gap = 0;					// back on the track
					else
						rec.gap = Math.max(0, rec.gap - dt * 0.2);	// a safety stop after ~1.2 s
				}
			}
			const catching = exact && !st.ex && !st.hold && rec.gap > 0;

			let k, kp, maxStep = 0;
			if (exact)
			{
				k = catching ? 1 - Math.exp(-dt / (BLEND_AFTER_GAP / 3)) : 1;
				kp = k;
				if (catching)
					maxStep = Math.max(0.02, speed * 1.5) * dt;	// px this frame may cover
			}
			else
			{
				k = raw ? 1 : 1 - Math.exp(-dt * 3 / smoothMs);
				kp = k;
				if (!raw && (((m & F.X) && Math.abs(v.x - inst.x) > TELEPORT) || ((m & F.Y) && Math.abs(v.y - inst.y) > TELEPORT)))
					kp = 1;
			}

			const ease = (cur, target, kk) =>
			{
				const d = target - cur;
				return Math.abs(d) < 0.05 ? target : cur + d * kk;
			};
			const clamp = (next, cur) =>
			{
				if (!maxStep)
					return next;
				const d = next - cur;
				return Math.abs(d) <= maxStep ? next : cur + Math.sign(d) * maxStep;
			};

			if (m & F.X) { const nx = clamp(ease(inst.x, v.x, kp), inst.x); if (nx !== inst.x) inst.x = nx; }
			if (m & F.Y) { const ny = clamp(ease(inst.y, v.y, kp), inst.y); if (ny !== inst.y) inst.y = ny; }
			if ((m & F.Z) && typeof inst.zElevation === "number") inst.zElevation = clamp(ease(inst.zElevation, v.z, kp), inst.zElevation);
			if (m & F.ANGLE)
			{
				const cur = angleOf(inst);
				const d = ((v.a - cur + 540) % 360 + 360) % 360 - 180;		// shortest way round
				const na = Math.abs(d) < 0.05 ? v.a : cur + d * k;
				if (typeof inst.angleDegrees === "number") inst.angleDegrees = na;
				else inst.angle = na * Math.PI / 180;
			}
			if (m & F.SIZE) { if (inst.width !== v.w) inst.width = v.w; if (inst.height !== v.h) inst.height = v.h; }
			if (m & F.MIRROR)
			{
				const w = Math.abs(inst.width);
				const want = v.mir ? -w : w;
				if (inst.width !== want) inst.width = want;
			}
			if ((m & F.ANIM) && v.anim && inst.animationName !== v.anim && typeof inst.setAnimation === "function")
			{
				try { inst.setAnimation(v.anim); }
				catch (e) { this._log("warn", "unknown animation: " + v.anim); }
			}
			if ((m & F.FRAME) && typeof inst.animationFrame === "number" && inst.animationFrame !== v.frame)
				inst.animationFrame = v.frame;
			if ((m & F.VISIBLE) && inst.isVisible !== !!v.vis) inst.isVisible = !!v.vis;
			if ((m & F.OPACITY) && inst.opacity !== v.op) inst.opacity = v.op;

			// instance variables registered with "Register object variable for sync"
			const vars = rec.vars || null;
			if (vars && v.vars && inst.instVars)
			{
				for (const def of vars)
				{
					const target = v.vars[def.name];
					if (target === undefined)
						continue;
					const cur = inst.instVars[def.name];
					let next = target;
					if (def.interp && (!exact || catching) && typeof cur === "number" && isFinite(cur) && typeof target === "number")
						next = ease(cur, target, k);
					if (next !== cur)
					{
						try { inst.instVars[def.name] = next; }
						catch (e) { this._log("warn", "cannot write the instance variable " + def.name); }
					}
				}
			}
		}

		// ---- object sync: registering --------------------------------

		// objClass is what the "object" parameter gives us; the instances picked by the
		// event conditions are registered. With several picked instances the slot
		// numbers go slot, slot+1, ... in the order they were picked.
		_register(objClass, owner, slot, mask)
		{
			if (!objClass || typeof objClass.getPickedInstances !== "function")
				return;
			owner = Math.floor(Number(owner)) || 0;
			slot = Math.floor(Number(slot)) || 0;
			let i = 0;
			for (const inst of objClass.getPickedInstances())
			{
				if (typeof inst.x !== "number" || typeof inst.y !== "number")
				{
					this._log("warn", "register object: only objects that are placed in the layout can be synced");
					continue;
				}
				let m = mask;
				if ((m & F.Z) && typeof inst.zElevation !== "number")
					m &= ~F.Z;					// this Construct version has no Z elevation
				if ((m & F.ANIM) && typeof inst.animationName !== "string")
					m &= ~(F.ANIM | F.FRAME);		// not a Sprite
				for (const [k, r] of this._sync)
				{
					if (r.uid === inst.uid)
						this._sync.delete(k);		// registered before: replace
				}
				const s = slot + i++;
				const key = owner + ":" + s;
				this._sync.set(key, { key: key, owner: owner, slot: s, uid: inst.uid, mask: m, interp: null, tag: "", type: objClass.name || "", vars: null, seen: false });
				this._log("debug", "synced object registered: owner " + owner + ", slot " + s);
			}
		}

		_unregister(objClass)
		{
			if (!objClass || typeof objClass.getPickedInstances !== "function")
				return;
			for (const inst of objClass.getPickedInstances())
			{
				for (const [k, r] of this._sync)
				{
					if (r.uid === inst.uid)
						this._sync.delete(k);
				}
			}
		}

		// ---- the simple object sync API ------------------------------
		//
		//	Sync object:          tag "player" = Sprite, sync X, Y and angle
		//	Bind local instance:  this Sprite is mine (default: the one in the layout)
		//	Start sync:           send mine, create and move the Sprite of each other player

		_syncObject(objClass, tag, scope, transform, interpolate, layer)
		{
			if (!objClass)
				return;
			tag = String(tag === undefined || tag === null ? "" : tag).trim();
			if (tag === "")
				tag = "object";
			if (!/^[A-Za-z0-9_.-]{1,32}$/.test(tag))
			{
				this._log("warn", "sync object: bad tag " + JSON.stringify(tag) + " (letters, digits, . _ and - only)");
				return;
			}
			const name = objClass.name || "";
			let def = this._defs.get(tag);
			if (def && def.name && name && def.name !== name)
			{
				this._log("warn", "sync object: tag \"" + tag + "\" is already used by " + def.name);
				return;
			}
			const tid = this._pickCombo(TRANSFORM_IDS, transform, "positionAngle");
			const mask = TRANSFORMS[tid];
			const wanted = SCOPES[this._pickCombo(SCOPE_IDS, scope, "player")] || "player";
			if (!def)
			{
				def = {
					tag: tag,
					name: name,
					cls: objClass,
					scope: wanted,
					mask: mask === undefined ? TRANSFORMS.positionAngle : mask,
					interp: interpolate !== false,
					layer: String(layer || ""),
					varRefs: [],				// "enabled instance variables", filled by Register object variable
					_vars: null
				};
				this._defs.set(tag, def);
				const list = this._defsByClass.get(name) || [];
				if (name && list.indexOf(tag) < 0)
					list.push(tag);
				this._defsByClass.set(name, list);
			}
			else
			{
				def.cls = objClass;
				def.scope = SCOPES[this._pickCombo(SCOPE_IDS, scope, "")] || def.scope;
				def.interp = interpolate !== false;
				if (mask !== undefined)
					def.mask = mask;
				if (layer)
					def.layer = String(layer);
			}
			this._log("info", "sync object: tag \"" + tag + "\" = " + (def.name || "object") + " (" + def.scope + ")");
		}

		// ---- instance variables ("Register object variable for sync") ---------
		//
		// The variable parameter of Construct is an index: the name is resolved lazily
		// from the instance variables of the first instance of that object type
		// (exactly like GamePush does), so renaming a variable does not break the game.

		_varNames(name)
		{
			if (this._varCache.has(name))
				return this._varCache.get(name);
			const inst = this._allInstances(this._clsByName(name))[0];
			const out = inst && inst.instVars ? Object.keys(inst.instVars) : null;
			if (out)
				this._varCache.set(name, out);
			return out;
		}

		_effectiveVars(def)
		{
			if (def._vars)
				return def._vars;
			const list = [];
			for (const ref of (def.varRefs || []))
			{
				if (!ref.name)
				{
					const names = this._varNames(def.name || "");
					if (names && ref.index >= 0 && ref.index < names.length)
						ref.name = names[ref.index];
				}
				if (ref.name && !list.some((v) => v.name === ref.name))
					list.push({ name: ref.name, interp: !!ref.interpolate });
			}
			def._vars = list;
			return list;
		}

		_registerObjectVariable(objClass, variable, interpolate)
		{
			if (!objClass)
				return;
			const name = objClass.name || "";
			const tags = this._defsByClass.get(name) || [];
			if (!tags.length)
			{
				this._log("warn", "register object variable: call \"Register object for sync\" for " + (name || "this object") + " first");
				return;
			}
			const index = parseInt(variable, 10);
			if (!(index >= 0))
			{
				this._log("warn", "register object variable: bad variable " + JSON.stringify(String(variable)));
				return;
			}
			for (const tag of tags)
			{
				const def = this._defs.get(tag);
				if (!def)
					continue;
				if (!def.varRefs)
					def.varRefs = [];
				const have = def.varRefs.find((r) => r.index === index);
				if (have)
					have.interpolate = !!interpolate;
				else
					def.varRefs.push({ index: index, interpolate: !!interpolate, name: "" });
				def._vars = null;
				// apply it right away, also to the records that are already registered,
				// so no "restart the sync" dance is needed
				const list = this._effectiveVars(def);
				for (const rec of this._sync.values())
				{
					if (rec.tag === tag)
						rec.vars = list;
				}
			}
			const names = this._varNames(name);
			this._log("info", "sync variable #" + index + (names && names[index] ? " (\"" + names[index] + "\")" : "") +
				" of " + (name || "object") + " registered, interpolate: " + (!!interpolate));
		}

		// The instance(s) picked by the event become mine (for every tag of that object
		// type). Without this action "Start sync" takes the instance that is in the
		// layout, which is what a player object usually is.
		_bindLocalInstance(objClass)
		{
			if (!objClass || typeof objClass.getPickedInstances !== "function")
				return;
			const tags = this._defsByClass.get(objClass.name || "") || [];
			if (!tags.length)
			{
				this._log("warn", "bind local instance: call \"Sync object\" for " + (objClass.name || "this object") + " first");
				return;
			}
			const picked = Array.from(objClass.getPickedInstances());
			if (!picked.length)
				return;
			let i = 0;
			for (const tag of tags)
			{
				const def = this._defs.get(tag);
				if (!def || (def.scope === "host" && this._hostId !== this._myId))
					continue;
				const inst = picked[i++];
				if (inst)
					this._bindUid(def, inst.uid);
			}
		}

		// The bound instance can disappear (layout change, respawn, or it is created after
		// "Start sync"). Re-checking the bindings now and then keeps sync alive instead of
		// letting it die silently - that is what makes it feel automatic, like GamePush.
		_rebind()
		{
			for (const def of this._defs.values())
			{
				// "mine" is the player scope (my id) or the host scope (the host id): the
				// id is 0 until the room is entered, so a binding created before the join
				// has to move to the real id afterwards.
				const owner = def.scope === "host" ? this._hostId : this._myId;
				const uid = this._bound.get(def.tag);
				if (uid !== undefined)
				{
					if (this._instByUid(uid) && this._sentAs(uid, owner))
						continue;
					this._bound.delete(def.tag);
					for (const [k, r] of Array.from(this._sync))
					{
						if (r.uid === uid)
							this._sync.delete(k);
					}
				}
				this._autoBind(def);
			}
		}

		// Was this instance already sent under this owner? (its record exists)
		_sentAs(uid, owner)
		{
			for (const r of this._sync.values())
			{
				if (r.uid === uid && r.owner === owner)
					return true;
			}
			return false;
		}

		_startSync()
		{
			if (!this._defs.size)
			{
				this._log("warn", "start sync: register an object first (\"Register object for sync\" action)");
				return;
			}
			this._syncOn = true;
			this._rebind();
			// Data that arrived before "Start sync" (or right after joining) is used too.
			for (const owner of Array.from(this._net.keys()))
			{
				this._adopt(owner);
				this._pruneProxies(owner);
			}
			this._log("info", "sync started: " + this._defs.size + " object type(s)");
		}

		_stopSync()
		{
			this._syncOn = false;
			this._dropProxies(false);
			for (const def of this._defs.values())
			{
				const uid = this._bound.get(def.tag);
				if (uid === undefined)
					continue;
				for (const [k, r] of Array.from(this._sync))
				{
					if (r.uid === uid)
						this._sync.delete(k);
				}
			}
			// tell the others to remove our objects as well
			for (let i = 0; i < this._sentChunks.length; i++)
			{
				if (this._sentChunks[i])
					this._queue({ t: "player.set", key: CHUNK_PREFIX + i, value: "" });
			}
			if (this._srvSync && this._syncLast && this._canSend())
				this._queue({ t: "sync", seq: ++this._syncSeq, ts: Math.round(this._now()), iv: Math.round(this._sendInterval), objs: [] });
			this._syncLast = "";
			this._flushOut();
			this._sentChunks = [];
			this._chunkTime = [];
			this._log("info", "sync stopped");
		}

		// The instance that is in the layout is mine; the ones the plugin created for
		// other players are not.
		_autoBind(def)
		{
			if (def.scope === "host" && this._hostId !== this._myId)
				return false;
			const uid = this._bound.get(def.tag);
			if (uid !== undefined)
			{
				if (this._instByUid(uid))
					return true;
				this._bound.delete(def.tag);
			}
			const used = new Set(this._bound.values());
			for (const inst of this._allInstances(this._clsOf(def)))
			{
				if (this._proxyUid.has(inst.uid) || used.has(inst.uid))
					continue;
				this._bindUid(def, inst.uid);
				return true;
			}
			this._log("warn", "sync object: no instance of " + (def.name || def.tag) + " to bind as mine (tag \"" + def.tag + "\")");
			return false;
		}

		_bindUid(def, uid)
		{
			const owner = def.scope === "host" ? this._hostId : this._myId;
			const old = this._bound.get(def.tag);
			if (old !== undefined && old !== uid)
			{
				for (const [k, r] of Array.from(this._sync))
				{
					if (r.uid === old)
						this._sync.delete(k);
				}
			}
			const slot = this._slotFor(owner, def.tag);
			const key = owner + ":" + slot;
			this._bound.set(def.tag, uid);
			this._sync.set(key, { key: key, owner: owner, slot: slot, uid: uid, mask: def.mask, interp: def.interp, tag: def.tag, type: def.name || "", vars: this._effectiveVars(def), seen: false });
			this._log("info", "sync: \"" + def.tag + "\" = " + (def.name || "object") + " uid " + uid + (owner === this._myId ? " (mine)" : " (host)"));
		}

		// A stable slot per (owner, tag): the other clients do not have to know it, but
		// it keeps the chunk layout steady while the game runs.
		_slotFor(owner, tag)
		{
			const key = owner + ":" + tag;
			const have = this._tagSlots.get(key);
			if (have !== undefined)
				return have;
			let s = this._nextSlot;
			while (this._sync.has(owner + ":" + s))
				s++;
			this._nextSlot = s + 1;
			this._tagSlots.set(key, s);
			return s;
		}

		// Objects of other players are created when their data arrives: the tag travels
		// with the data, so every client builds the same picture without extra events.
		_adopt(owner)
		{
			const chunks = this._net.get(owner);
			if (!chunks)
				return;
			for (const c of chunks)
			{
				if (!c)
					continue;
				for (const [slot, st] of c)
				{
					const def = st.v && st.v.tag ? this._defs.get(st.v.tag) : null;
					if (!def)
						continue;
					const rec = this._sync.get(owner + ":" + slot);
					if (rec && this._instByUid(rec.uid))
						continue;
					this._makeProxy(def, owner, slot, st.v);
				}
			}
		}

		_makeProxy(def, owner, slot, v)
		{
			const cls = this._clsOf(def);
			if (!cls || typeof cls.createInstance !== "function")
			{
				if (!this._warnedProxy)
				{
					this._warnedProxy = true;
					this._log("warn", "cannot create the objects of other players: this Construct version has no createInstance for object types");
				}
				return null;
			}
			let inst = null;
			try
			{
				inst = cls.createInstance(this._layerFor(def), fin(v ? v.x : 0), fin(v ? v.y : 0));
			}
			catch (e)
			{
				this._log("warn", "cannot create the object of player " + owner + " (tag \"" + def.tag + "\"): " + e);
				return null;
			}
			if (!inst)
				return null;
			let byTag = this._proxies.get(def.tag);
			if (!byTag)
			{
				byTag = new Map();
				this._proxies.set(def.tag, byTag);
			}
			byTag.set(owner, inst.uid);
			this._proxyUid.set(inst.uid, { tag: def.tag, owner: owner, slot: slot });
			const key = owner + ":" + slot;
			this._sync.set(key, { key: key, owner: owner, slot: slot, uid: inst.uid, mask: def.mask, interp: def.interp, tag: def.tag, type: def.name || "", vars: this._effectiveVars(def), seen: false });
			this._curProxy = { uid: inst.uid, tag: def.tag, owner: owner };
			this._log("debug", "created " + (def.name || "object") + " for player " + owner + " (tag \"" + def.tag + "\", slot " + slot + ")");
			// global (host) objects are entities, player objects are proxies - like in GamePush
			this._trigger(this._cnd(def.scope === "host" ? "OnEntityCreated" : "OnProxyCreated"));
			return inst;
		}

		// An owner stops sending a slot when his object is gone: remove our copy.
		_pruneProxies(owner)
		{
			const chunks = this._net.get(owner);
			const live = new Set();
			if (chunks)
			{
				for (const c of chunks)
				{
					if (!c)
						continue;
					for (const slot of c.keys())
						live.add(slot);
				}
			}
			for (const info of Array.from(this._proxyUid.values()))
			{
				if (info.owner === owner && !live.has(info.slot))
					this._dropProxy(info.tag, owner, false);
			}
		}

		_dropProxy(tag, owner, quiet)
		{
			const byTag = this._proxies.get(tag);
			const uid = byTag ? byTag.get(owner) : undefined;
			if (uid === undefined)
				return;
			byTag.delete(owner);
			this._proxyUid.delete(uid);
			for (const [k, r] of Array.from(this._sync))
			{
				if (r.uid === uid)
					this._sync.delete(k);
			}
			this._curProxy = { uid: uid, tag: tag, owner: owner };
			this._log("debug", "removed the object of player " + owner + " (tag \"" + tag + "\")");
			if (!quiet)
			{
				const def = this._defs.get(tag);
				this._trigger(this._cnd(def && def.scope === "host" ? "OnEntityDestroyed" : "OnProxyDestroyed"));
			}
			const inst = this._instByUid(uid);
			if (inst && typeof inst.destroy === "function")
			{
				try { inst.destroy(); }
				catch (e) { /* ignore */ }
			}
		}

		_dropTag(tag, quiet)
		{
			const byTag = this._proxies.get(tag);
			if (!byTag)
				return;
			for (const owner of Array.from(byTag.keys()))
				this._dropProxy(tag, owner, quiet);
		}

		_dropProxies(quiet)
		{
			for (const tag of Array.from(this._proxies.keys()))
				this._dropTag(tag, quiet);
			this._proxies.clear();
			this._proxyUid.clear();
		}

		_dropOwner(owner)
		{
			for (const info of Array.from(this._proxyUid.values()))
			{
				if (info.owner === owner)
					this._dropProxy(info.tag, owner, false);
			}
		}

		// Every owner that is not in "keep" (the room player list) loses his objects.
		_pruneOwners(keep)
		{
			const ids = keep instanceof Set ? keep : new Set(keep);
			for (const info of Array.from(this._proxyUid.values()))
			{
				if (!ids.has(info.owner))
					this._dropProxy(info.tag, info.owner, false);
			}
		}

		// ---- small helpers -------------------------------------------

		_instByUid(uid)
		{
			try
			{
				return this.runtime ? (this.runtime.getInstanceByUid(uid) || null) : null;
			}
			catch (e)
			{
				return null;
			}
		}

		_clsByName(name)
		{
			try
			{
				return name && this.runtime && this.runtime.objects ? (this.runtime.objects[name] || null) : null;
			}
			catch (e)
			{
				return null;
			}
		}

		// The object type is looked up by name on every use (like GamePush does): the
		// reference taken when "Sync object" ran may be older than the layout.
		_clsOf(def)
		{
			return this._clsByName(def.name) || def.cls || null;
		}

		_allInstances(cls)
		{
			if (!cls)
				return [];
			try
			{
				if (typeof cls.getAllInstances === "function")
					return cls.getAllInstances() || [];
			}
			catch (e) { /* ignore */ }
			return [];
		}

		_layerFor(def)
		{
			const layout = this.runtime ? this.runtime.layout : null;
			const has = (n) =>
			{
				try { return !!(layout && typeof layout.getLayer === "function" && layout.getLayer(n)); }
				catch (e) { return false; }
			};
			if (def.layer && has(def.layer))
				return def.layer;
			const uid = this._bound.get(def.tag);
			const inst = uid === undefined ? null : this._instByUid(uid);
			if (inst && inst.layer && inst.layer.name && has(inst.layer.name))
				return inst.layer.name;
			return 0;
		}

		_forEachEntity(tag)
		{
			const sdk = this.runtime && this.runtime.sdk;
			if (!sdk || typeof sdk.createLoopingConditionContext !== "function")
			{
				this._log("error", "'For each object' needs a newer Construct version (looping conditions in addon SDK v2)");
				return false;
			}
			const want = String(tag === undefined || tag === null ? "" : tag);
			const list = [];
			for (const rec of this._sync.values())
			{
				if (want === "" || rec.tag === want)
					list.push(rec);
			}
			list.sort((a, b) => (a.owner - b.owner) || (a.slot - b.slot));
			const saved = this._curEntity;
			const ctx = sdk.createLoopingConditionContext();
			for (const rec of list)
			{
				this._curEntity = rec;
				ctx.retrigger();
				if (ctx.isStopped)
					break;
			}
			this._curEntity = saved;
			ctx.release();
			return false;
		}

		_proxyMatch(tag)
		{
			if (!this._curProxy)
				return false;
			const want = String(tag === undefined || tag === null ? "" : tag);
			return want === "" || this._curProxy.tag === want;
		}

		// ---- room rules ----------------------------------------------

		_limit(v)
		{
			if (v === "" || v === null || v === undefined)
				return undefined;
			const n = Number(v);
			return isFinite(n) ? n : undefined;
		}

		_ruleAdd(key, kind, mode, min, max, maxDelta, reject)
		{
			key = String(key);
			if (!/^[A-Za-z0-9._]{1,64}$/.test(key))
			{
				this._log("warn", "room rule: bad key name " + JSON.stringify(key) + " (letters, digits, . and _ only)");
				return;
			}
			const r = { kind: RULE_KINDS[kind] || "num", mode: RULE_MODES[mode] || "set" };
			const lo = this._limit(min), hi = this._limit(max);
			if (r.kind === "num")
			{
				if (lo !== undefined) r.min = lo;
				if (hi !== undefined) r.max = hi;
				if (Number(maxDelta) > 0) r.maxDelta = Number(maxDelta);
				if (reject) r.reject = true;
			}
			this._rules.schema[key] = r;
		}

		_ruleInit(key, value)
		{
			this._rules.init[String(key)] = value;
		}

		_rulesPayload()
		{
			const r = this._rules;
			const out = {};
			if (r.strict)
				out.strict = true;
			if (Object.keys(r.schema).length)
				out.schema = JSON.parse(JSON.stringify(r.schema));
			if (Object.keys(r.init).length)
			{
				const init = {};
				for (const k of Object.keys(r.init))
				{
					let v = r.init[k];
					const rule = r.schema[k];
					if (rule && rule.kind === "bool")
						v = !!Number(v) || v === true || v === "true";
					init[k] = v;
				}
				out.init = init;
			}
			return out;
		}

		// ---- loops ---------------------------------------------------

		_forEachPlayer()
		{
			const sdk = this.runtime && this.runtime.sdk;
			if (!sdk || typeof sdk.createLoopingConditionContext !== "function")
			{
				this._log("error", "'For each player' needs a newer Construct version (looping conditions in addon SDK v2)");
				return false;
			}
			const ids = Array.from(this._players.keys()).sort((a, b) => a - b);
			const saved = this._curPlayer;
			const ctx = sdk.createLoopingConditionContext();
			for (const id of ids)
			{
				this._curPlayer = id;
				ctx.retrigger();
				if (ctx.isStopped)
					break;
			}
			this._curPlayer = saved;
			ctx.release();
			return false;
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
