import { START_FEN } from './session.js?v=20261028-14';

/**
 * A tiny in-memory stand-in for StarkFlowClient. ChessSession speaks the same
 * room/state events against it, so the offline bot uses exactly the same chess
 * core and UI as an online game.
 */
export class LocalNet {
  constructor({ playerName, botName, playerColor = 'w' }) {
    this.handlers = new Map();
    this.connected = true;
    this.latency = null;
    this.you = 1;
    this.hostId = 1;
    this.welcomeInfo = { name: playerName };
    this.room = { id: 'offline', name: botName, maxPlayers: 2, suspendTTL: 0 };
    this.players = new Map([
      [1, { id: 1, name: playerName, status: 'active', props: {} }],
      [2, { id: 2, name: botName, status: 'active', props: {} }],
    ]);
    const whiteId = playerColor === 'b' ? 2 : 1;
    const blackId = playerColor === 'b' ? 1 : 2;
    const now = Date.now();
    this.game = {
      v: 1,
      rev: 1,
      fen: START_FEN,
      moves: [],
      lastMove: null,
      whiteId,
      blackId,
      status: 'playing',
      winner: null,
      reason: null,
      drawOffer: 0,
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      turnStartedAt: now,
    };
    this.state = { game: JSON.stringify(this.game) };
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.handlers.get(type) || []) fn(detail);
  }

  start() {
    this.emit('room.joined', {
      room: this.room,
      you: this.you,
      hostId: this.hostId,
      players: this.playerList(),
      state: this.state,
      created: true,
      resumed: false,
    });
  }

  isHost() {
    return true;
  }

  playerList() {
    return [...this.players.values()].sort((a, b) => a.id - b.id);
  }

  activePlayers() {
    return this.playerList();
  }

  setState(key, value) {
    const old = this.state[key];
    this.state[key] = value;
    queueMicrotask(() => this.emit('state.changed', { key, value, old, by: this.you }));
    return true;
  }

  request() {
    return true;
  }

  listRooms() {}

  leaveRoom() {
    this.emit('room.left', { reason: 'self' });
  }

  destroy() {
    this.handlers.clear();
  }
}
