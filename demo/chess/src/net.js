const TOKEN_PREFIX = 'ornate-chess:token:';

/**
 * Small StarkFlow client for the browser. It implements only what the salon
 * needs: identity, the room list, room lifecycle, shared room state, events,
 * ping, token resume and automatic reconnection.
 */
export class StarkFlowClient {
  constructor({ url, app, lobby = 'salon', name = 'Guest', storage = null }) {
    this.url = url;
    this.app = app;
    this.lobby = lobby;
    this.name = name;
    this.storage = storage || globalThis.sessionStorage || null;

    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.active = false;
    this.intentionalClose = false;
    this.retry = 0;
    this.retryTimer = null;
    this.connectTimer = null;
    this.heartbeatTimer = null;
    this.lastPongAt = 0;
    this.openedAt = 0;
    this.shortDrops = 0;

    this.token = this.#loadToken();
    this.userId = '';
    this.serverOffset = 0;
    this.latency = null;
    this.welcomeInfo = null;
    this.room = null;
    this.you = 0;
    this.hostId = 0;
    this.players = new Map();
    this.state = {};
    this.rooms = [];
    this.wantRoom = null;
    this.seq = 0;
    this.handlers = new Map();
    this.welcomeWaiters = [];
    this.identityWaiters = [];
  }

  /* -------------------------------------------------------------- events */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.handlers.get(type) || []) {
      try {
        fn(detail);
      } catch (err) {
        console.error('[starkflow] handler failed', type, err);
      }
    }
  }

  /* ------------------------------------------------------------ identity */
  #tokenKey() {
    return TOKEN_PREFIX + this.app;
  }

  #loadToken() {
    const storage = this.storage;
    if (!storage) return this.token || '';
    try {
      return storage.getItem(this.#tokenKey()) || '';
    } catch {
      return this.token || '';
    }
  }

  #saveToken(token) {
    this.token = token || '';
    const storage = this.storage;
    if (!storage) return;
    try {
      if (token) storage.setItem(this.#tokenKey(), token);
      else storage.removeItem(this.#tokenKey());
    } catch {
      /* private mode */
    }
  }

  forgetIdentity() {
    this.#saveToken('');
    this.userId = '';
  }

  /* ----------------------------------------------------------- connection */
  connect(name = this.name) {
    this.name = (name || 'Guest').trim().slice(0, 20) || 'Guest';
    this.active = true;
    this.intentionalClose = false;
    this.retry = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.#open();
    return this.waitForWelcome();
  }

  waitForWelcome(timeout = 12000) {
    if (this.connected) return Promise.resolve(this.welcomeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.welcomeWaiters = this.welcomeWaiters.filter((w) => w.resolve !== done);
        reject(new Error('timeout'));
      }, timeout);
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      this.welcomeWaiters.push({ resolve: done, reject, done });
    });
  }

  #open() {
    if (!this.active) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.connecting = true;
    this.emit('status', { state: 'connecting', retry: this.retry });

    const base = this.url.replace(/\?.*$/, '').replace(/\/+$/, '');
    const url = `${base}?v=1&app=${encodeURIComponent(this.app)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.connecting = false;
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.openedAt = 0;
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      this.connecting = false;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
      this.emit('status', { state: 'timeout' });
      this.#scheduleReconnect();
    }, 12000);

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      this.openedAt = Date.now();
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.connecting = false;
      const hello = { t: 'hello', token: this.token, name: this.name };
      ws.send(JSON.stringify(hello));
      this.emit('status', { state: 'hello' });
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg && msg.t === 'batch' && Array.isArray(msg.items)) {
        for (const item of msg.items) this.#onMessage(item);
      } else if (msg) {
        this.#onMessage(msg);
      }
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.emit('status', { state: 'error' });
    });

    ws.addEventListener('close', (event) => {
      if (this.ws !== ws) return;
      const shortLived = !!this.openedAt && Date.now() - this.openedAt < 2500;
      this.openedAt = 0;
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.ws = null;
      this.connecting = false;
      this.connected = false;
      this.latency = null;
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (shortLived && !this.intentionalClose) {
        // A socket that dies right after hello, over and over, is the signature
        // of a second tab with the same stored identity: the server keeps only
        // the newest session and the two tabs kick each other out in a loop.
        this.shortDrops += 1;
        if (this.shortDrops === 3) this.emit('duplicate-hint');
      } else {
        this.shortDrops = 0;
      }
      this.emit('status', { state: 'offline', code: event.code });
      if (!this.intentionalClose && this.active) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (!this.active || this.intentionalClose) return;
    this.retry += 1;
    const delay = Math.min(500 * 2 ** Math.min(this.retry - 1, 4), 6000);
    this.emit('status', { state: 'retrying', retry: this.retry, delay });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.#open();
    }, delay);
  }

  manualRetry() {
    this.active = true;
    this.intentionalClose = false;
    this.retry = 0;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    this.retryTimer = null;
    this.connectTimer = null;
    this.#open();
  }

  disconnect() {
    this.intentionalClose = true;
    this.active = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    clearInterval(this.heartbeatTimer);
    this.retryTimer = null;
    this.connectTimer = null;
    this.heartbeatTimer = null;
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        /* noop */
      }
      this.ws = null;
    }
    this.connected = false;
  }

  async rename(name) {
    const next = (name || '').trim().slice(0, 20) || 'Guest';
    this.name = next;
    if (this.room) return; // identity is fixed while seated
    if (this.connected && this.welcomeInfo?.name === next) return;
    this.intentionalClose = false;
    this.retry = 0;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    const wait = new Promise((resolve) => this.identityWaiters.push(resolve));
    if (this.ws) {
      try {
        this.intentionalClose = true;
        this.ws.close(1000);
      } catch {
        /* noop */
      }
      this.ws = null;
      this.intentionalClose = false;
    }
    this.connected = false;
    this.#open();
    await wait;
  }

  #startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPongAt > 75000) {
        this.emit('status', { state: 'stale' });
        try {
          this.ws?.close();
        } catch {
          /* noop */
        }
        return;
      }
      this.send({ t: 'ping', ts: Date.now() });
    }, 20000);
  }

  /* --------------------------------------------------------------- send */
  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  request(type, extra = {}) {
    return this.send({ t: type, id: ++this.seq, ...extra });
  }

  /* -------------------------------------------------------------- rooms */
  listRooms() {
    this.request('room.list', { lobby: this.lobby });
  }

  createRoom(name, options = {}) {
    const room = (name || '').trim().slice(0, 32);
    return this.request('room.join', {
      room,
      create: true,
      unique: true,
      maxPlayers: options.maxPlayers || 8,
      emptyTTL: options.emptyTTL || 300,
      lobby: this.lobby,
      ...(options.suspendTTL ? { suspendTTL: options.suspendTTL } : {}),
      ...(options.password ? { password: options.password } : {}),
    });
  }

  joinRoom(ref, create = false) {
    if (!ref) return false;
    this.wantRoom = String(ref);
    return this.request('room.join', { room: String(ref), create: false, lobby: this.lobby });
  }

  leaveRoom() {
    if (!this.room) return;
    this.request('room.leave');
    this.#clearRoom();
    this.emit('room.left', { reason: 'self' });
    if (this.connected) this.listRooms();
  }

  #clearRoom() {
    this.room = null;
    this.you = 0;
    this.hostId = 0;
    this.players.clear();
    this.state = {};
    this.wantRoom = null;
  }

  /* ------------------------------------------------------------ game data */
  setState(key, value) {
    return this.request('state.set', { key, value });
  }

  sendEvent(code, data, to = 'others') {
    return this.request('event', { code, data, to });
  }

  isHost() {
    return !!this.room && this.you === this.hostId;
  }

  playerList() {
    return [...this.players.values()].sort((a, b) => a.id - b.id);
  }

  activePlayers() {
    return this.playerList().filter((p) => p.status !== 'suspended');
  }

  /* -------------------------------------------------------------- receive */
  #onMessage(m) {
    switch (m.t) {
      case 'welcome': {
        this.connected = true;
        this.connecting = false;
        this.retry = 0;
        this.userId = m.userId || '';
        this.serverOffset = Number(m.serverTime || Date.now()) - Date.now();
        this.welcomeInfo = {
          ...m,
          name: this.name,
        };
        this.#saveToken(m.token || '');
        this.#startHeartbeat();
        this.emit('welcome', this.welcomeInfo);
        this.emit('status', { state: 'online' });

        for (const waiter of this.welcomeWaiters.splice(0)) waiter.resolve(this.welcomeInfo);
        for (const resolve of this.identityWaiters.splice(0)) resolve();

        if (this.wantRoom) {
          this.request('room.join', { room: this.wantRoom, create: false, lobby: this.lobby });
        } else {
          this.listRooms();
        }
        break;
      }

      case 'room.joined': {
        this.room = {
          id: m.roomId || '',
          name: m.room || 'Table',
          created: !!m.created,
          resumed: !!m.resumed,
          maxPlayers: m.maxPlayers || 8,
          suspendTTL: m.suspendTTL,
        };
        this.you = m.you;
        this.shortDrops = 0;
        this.hostId = m.hostId || 0;
        this.wantRoom = this.room.id || this.room.name;
        this.players.clear();
        for (const p of m.players || []) this.players.set(p.id, p);
        this.state = { ...(m.state || {}) };
        this.emit('room.joined', {
          room: this.room,
          you: this.you,
          hostId: this.hostId,
          players: this.playerList(),
          state: this.state,
          resumed: !!m.resumed,
          created: !!m.created,
        });
        break;
      }

      case 'room.list.result':
        this.rooms = Array.isArray(m.rooms) ? m.rooms : [];
        this.emit('rooms', this.rooms);
        break;

      case 'player.joined': {
        if (m.player) {
          this.players.set(m.player.id, m.player);
          this.emit('players.changed', { players: this.playerList(), joined: m.player.id });
        }
        break;
      }

      case 'player.resumed': {
        if (m.player) {
          const previous = this.players.get(m.player.id);
          this.players.set(m.player.id, { ...previous, ...m.player, status: 'active' });
          this.emit('players.changed', { players: this.playerList(), resumed: m.player.id });
        }
        break;
      }

      case 'player.suspended': {
        const p = [...this.players.values()].find((item) => item.id === m.id);
        if (p) {
          p.status = 'suspended';
          this.emit('players.changed', { players: this.playerList(), suspended: m.id });
        }
        break;
      }

      case 'player.left': {
        const player = [...this.players.values()].find((item) => item.id === m.id);
        this.players.delete(m.id);
        this.emit('players.changed', { players: this.playerList(), left: m.id, reason: m.reason, player });
        break;
      }

      case 'host.changed':
        this.hostId = m.hostId || 0;
        this.emit('host.changed', { hostId: this.hostId });
        break;

      case 'state.changed':
        this.state[m.key] = m.value;
        this.emit('state.changed', { key: m.key, value: m.value, old: m.old, by: m.by });
        break;

      case 'event':
        this.emit('game.event', { code: m.code, data: m.data, from: m.from });
        break;

      case 'pong':
        this.lastPongAt = Date.now();
        this.latency = Math.max(0, Date.now() - Number(m.ts || 0));
        this.emit('latency', this.latency);
        break;

      case 'err': {
        this.emit('error', { code: m.code, msg: m.msg, id: m.id });
        if (m.code === 200) {
          this.forgetIdentity();
          this.emit('status', { state: 'reauth' });
          setTimeout(() => {
            if (this.active) {
              this.intentionalClose = true;
              try {
                this.ws?.close();
              } catch {
                /* noop */
              }
              this.ws = null;
              this.intentionalClose = false;
              this.connected = false;
              this.#open();
            }
          }, 250);
        }
        if (m.code === 300) {
          const missing = this.wantRoom || this.room?.id || this.room?.name || '';
          const lost = !!this.room;
          this.#clearRoom();
          this.emit('room.missing', { room: missing, lost });
          this.listRooms();
        }
        if (m.code === 301) {
          this.wantRoom = null;
          this.emit('room.full');
        }
        break;
      }

      case 'ok':
        this.emit('ack', { id: m.id });
        break;

      case 'batch':
        for (const item of m.items || []) this.#onMessage(item);
        break;

      default:
        break;
    }
  }
}
