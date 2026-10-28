import { Chess, validateFen } from '../vendor/chess.js/chess.js';
import { t } from './i18n.js?v=20261028-9';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MAX_STORED_MOVES = 360;

const clone = (value) => JSON.parse(JSON.stringify(value));

function decodeGame(raw) {
  if (!raw) return null;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || typeof value.fen !== 'string') return null;
  if (!validateFen(value.fen).ok) return null;
  return {
    v: 1,
    rev: Number(value.rev) || 1,
    fen: value.fen,
    moves: Array.isArray(value.moves) ? value.moves.filter((m) => typeof m === 'string').slice(-MAX_STORED_MOVES) : [],
    lastMove: value.lastMove && value.lastMove.from && value.lastMove.to ? value.lastMove : null,
    whiteId: Number(value.whiteId) || 0,
    blackId: Number(value.blackId) || 0,
    whiteUserId: typeof value.whiteUserId === 'string' ? value.whiteUserId : '',
    blackUserId: typeof value.blackUserId === 'string' ? value.blackUserId : '',
    status: typeof value.status === 'string' ? value.status : 'waiting',
    winner: value.winner === 'w' || value.winner === 'b' ? value.winner : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
    drawOffer: Number(value.drawOffer) || 0,
    createdAt: Number(value.createdAt) || Date.now(),
    startedAt: Number(value.startedAt) || 0,
    updatedAt: Number(value.updatedAt) || Date.now(),
    turnStartedAt: Number(value.turnStartedAt) || Date.now(),
  };
}

function outcomeAfter(chess, mover) {
  if (chess.isCheckmate()) {
    return { status: 'checkmate', winner: mover, reason: 'checkmate' };
  }
  if (chess.isStalemate()) {
    return { status: 'stalemate', winner: null, reason: 'stalemate' };
  }
  if (chess.isInsufficientMaterial()) {
    return { status: 'draw', winner: null, reason: 'material' };
  }
  if (chess.isThreefoldRepetition()) {
    return { status: 'draw', winner: null, reason: 'repetition' };
  }
  if (chess.isDrawByFiftyMoves()) {
    return { status: 'draw', winner: null, reason: 'fifty' };
  }
  if (chess.isDraw()) {
    return { status: 'draw', winner: null, reason: 'draw' };
  }
  return { status: 'playing', winner: null, reason: null };
}

/**
 * Owns the shared chess state. StarkFlow stores one JSON document in the
 * `game` room-state key; every client derives its board from it. The server
 * relays and orders writes, the players validate their own moves.
 */
export class ChessSession {
  constructor(net) {
    this.net = net;
    this.game = null;
    this.chess = null;
    this.myColor = null;
    this.pending = false;
    this.pendingTimer = null;
    this.resyncing = false;
    this.resyncTimer = null;
    this.resultAnnounced = false;
    this.lastTurn = null;
    this.handlers = new Map();
    this.unsubs = [];

    this.#bind();
  }

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
        console.error('[chess] handler failed', type, err);
      }
    }
  }

  get room() {
    return this.net.room;
  }

  get you() {
    return this.net.you;
  }

  get isHost() {
    return this.net.isHost();
  }

  get isSpectator() {
    return !!this.room && !!this.game && !this.myColor;
  }

  get isPlaying() {
    return !!this.game && this.game.status === 'playing' && !!this.myColor;
  }

  get turn() {
    return this.chess?.turn() || 'w';
  }

  get inCheck() {
    return this.chess?.inCheck() || false;
  }

  canMoveFrom(square) {
    if (!this.chess || !this.myColor || this.pending) return false;
    if (this.game?.status !== 'playing') return false;
    if (this.chess.turn() !== this.myColor) return false;
    const piece = this.chess.get(square);
    return !!piece && piece.color === this.myColor;
  }

  legalMoves(square) {
    if (!this.chess || !square) return [];
    try {
      return this.chess.moves({ square, verbose: true });
    } catch {
      return [];
    }
  }

  #bind() {
    this.unsubs.push(
      this.net.on('room.joined', () => this.#onJoined()),
      this.net.on('players.changed', (change) => this.#onPlayers(change)),
      this.net.on('host.changed', () => {
        this.#maybeSeat();
        this.#resyncSeats();
      }),
      this.net.on('state.changed', (change) => {
        if (change.key === 'game') this.#onState(change.value, change.old);
      }),
      this.net.on('room.left', () => this.#reset()),
      this.net.on('room.missing', () => this.#reset()),
    );
  }

  destroy() {
    for (const off of this.unsubs) off();
    clearTimeout(this.pendingTimer);
    clearTimeout(this.resyncTimer);
  }

  #reset() {
    clearTimeout(this.pendingTimer);
    clearTimeout(this.resyncTimer);
    this.resyncing = false;
    this.pending = false;
    this.game = null;
    this.chess = null;
    this.myColor = null;
    this.resultAnnounced = false;
    this.lastTurn = null;
  }

  #onJoined() {
    const raw = this.net.state.game;
    this.game = decodeGame(raw);
    this.chess = this.game ? new Chess(this.game.fen) : null;
    this.myColor = this.#colorForYou();
    this.resultAnnounced = !!this.game && this.game.status !== 'playing' && this.game.status !== 'waiting';
    this.pending = false;
    clearTimeout(this.pendingTimer);

    if (!this.game) {
      if (this.net.isHost()) {
        this.#createGame();
      } else {
        this.emit('change', this.snapshot());
      }
      return;
    }

    if (this.net.isHost()) {
      const active = new Set(this.net.activePlayers().map((p) => p.id));
      const held = (id, userId) => active.has(id) || (!!userId && this.net.playerList().some((p) => p.userId === userId));
      const nobodyAtTable = !held(this.game.whiteId, this.game.whiteUserId) && !held(this.game.blackId, this.game.blackUserId);
      if (nobodyAtTable) {
        // A link can outlive its players. A fresh host inherits the table,
        // not a frozen game between two ghosts.
        this.#write({
          ...this.game,
          fen: START_FEN,
          moves: [],
          lastMove: null,
          whiteId: this.net.you,
          blackId: 0,
          whiteUserId: this.net.userId,
          blackUserId: '',
          status: 'waiting',
          winner: null,
          reason: null,
          drawOffer: 0,
          createdAt: Date.now(),
          startedAt: 0,
          turnStartedAt: Date.now(),
        });
        this.emit('change', this.snapshot());
        return;
      }
    }

    if (this.game.status === 'waiting') this.#maybeSeat();
    else this.#resyncSeats();
    this.emit('change', this.snapshot());
    this.#emitMoveIfAny(null);
    this.#announceTurn(true);
  }

  snapshot() {
    return {
      room: this.room,
      game: this.game,
      chess: this.chess,
      myColor: this.myColor,
      isHost: this.net.isHost(),
      isSpectator: this.isSpectator,
      players: this.net.playerList(),
      pending: this.pending,
      turn: this.chess?.turn() || null,
      inCheck: this.chess?.inCheck() || false,
    };
  }

  #colorForYou() {
    if (!this.game) return null;
    if (this.game.whiteId === this.you) return 'w';
    if (this.game.blackId === this.you) return 'b';
    const userId = this.net.userId;
    if (!userId) return null;
    const released = (id) => !id || !this.net.players.has(id);
    if (this.game.whiteUserId === userId && released(this.game.whiteId)) return 'w';
    if (this.game.blackUserId === userId && released(this.game.blackId)) return 'b';
    return null;
  }

  #createGame() {
    const now = Date.now();
    const game = {
      v: 1,
      rev: 1,
      fen: START_FEN,
      moves: [],
      lastMove: null,
      whiteId: this.net.hostId || this.net.you,
      blackId: 0,
      whiteUserId: this.net.userId,
      blackUserId: '',
      status: 'waiting',
      winner: null,
      reason: null,
      drawOffer: 0,
      createdAt: now,
      startedAt: 0,
      updatedAt: now,
      turnStartedAt: now,
    };
    this.net.setState('game', JSON.stringify(game));
  }

  #userIdOf(id) {
    if (!id) return '';
    if (id === this.net.you) return this.net.userId;
    return this.net.players.get(id)?.userId || '';
  }

  #maybeSeat() {
    if (!this.game || this.game.status !== 'waiting' || !this.net.isHost()) return;
    const active = this.net.activePlayers();
    let whiteId = this.game.whiteId;
    if (!active.some((p) => p.id === whiteId)) whiteId = this.net.you;
    const whiteUserId = this.#userIdOf(whiteId) || this.game.whiteUserId || this.net.userId;
    const opponent = active.find((p) => p.id !== whiteId);
    if (!opponent) {
      if (whiteId !== this.game.whiteId || whiteUserId !== this.game.whiteUserId) {
        this.#write({ ...this.game, whiteId, whiteUserId });
      }
      return;
    }
    const now = Date.now();
    this.#write({
      ...this.game,
      whiteId,
      whiteUserId,
      blackId: opponent.id,
      blackUserId: opponent.userId || '',
      status: 'playing',
      startedAt: now,
      turnStartedAt: now,
    });
  }

  /**
   * Seats are stored twice: the player id the room gave me and the user id that
   * survives a reconnect. When a side comes back with a new player id, the host
   * moves the seat to it, so the game continues instead of turning into a
   * spectator view.
   */
  #resyncSeats() {
    if (!this.net.isHost() || this.game?.status !== 'playing' || this.resyncing) return;
    const active = this.net.playerList().filter((p) => p.status !== 'suspended');
    const seatId = (userId, id) => {
      if (!userId) return id;
      const player = active.find((p) => p.userId === userId);
      return player ? player.id : id;
    };
    const whiteId = seatId(this.game.whiteUserId, this.game.whiteId);
    const blackId = seatId(this.game.blackUserId, this.game.blackId);
    if (whiteId === this.game.whiteId && blackId === this.game.blackId) return;
    this.resyncing = true;
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.resyncing = false;
    }, 2000);
    this.#write({ ...this.game, whiteId, blackId, updatedAt: Date.now() });
  }

  #onPlayers(change) {
    if (this.net.isHost()) {
      if (this.game?.status === 'waiting') this.#maybeSeat();
      else this.#resyncSeats();
      if (change.left && change.reason !== 'timeout' && this.game?.status === 'playing') {
        const isSide = change.left === this.game.whiteId || change.left === this.game.blackId;
        if (isSide) {
          setTimeout(() => this.#claimAbandon(change.left), 350);
        }
      }
    }
    this.myColor = this.#colorForYou();
    this.emit('change', this.snapshot());
  }

  #claimAbandon(leftId) {
    if (!this.net.isHost() || !this.game || this.game.status !== 'playing') return;
    if (leftId !== this.game.whiteId && leftId !== this.game.blackId) return;
    const winner = leftId === this.game.whiteId ? 'b' : 'w';
    this.#write({
      ...this.game,
      status: 'abandoned',
      winner,
      reason: 'abandoned',
      drawOffer: 0,
      updatedAt: Date.now(),
    });
  }

  #onState(raw, oldRaw) {
    let next = decodeGame(raw);
    if (!next) {
      this.emit('invalid-state');
      return;
    }
    const previous = this.game;
    if (previous && next.rev <= previous.rev) {
      return;
    }
    const oldFen = previous?.fen || null;
    let nextChess;
    try {
      nextChess = new Chess(next.fen);
    } catch {
      this.emit('invalid-state');
      return;
    }

    this.game = next;
    this.chess = nextChess;
    this.myColor = this.#colorForYou();
    this.pending = false;
    clearTimeout(this.pendingTimer);
    this.resyncing = false;
    clearTimeout(this.resyncTimer);

    const snapshot = this.snapshot();
    this.emit('change', snapshot);
    this.#emitMoveIfAny(previous, oldFen);
    if (next.status !== 'playing' && next.status !== 'waiting' && !this.resultAnnounced) {
      this.resultAnnounced = true;
      this.emit('result', snapshot);
    }
    if (next.status === 'playing') this.resultAnnounced = false;
    this.#announceTurn(false);
  }

  #emitMoveIfAny(previous, oldFen) {
    if (!this.game?.lastMove) return;
    const isFresh = !previous || previous.lastMove?.san !== this.game.lastMove.san || previous.rev !== this.game.rev;
    if (!isFresh) return;
    this.emit('move', {
      move: this.game.lastMove,
      previousFen: oldFen,
      fen: this.game.fen,
      status: this.game.status,
      inCheck: this.chess?.inCheck() || false,
      myColor: this.myColor,
    });
  }

  #announceTurn(initial) {
    if (!this.game || this.game.status !== 'playing') {
      this.lastTurn = null;
      return;
    }
    const turn = this.chess.turn();
    if (initial || this.lastTurn !== turn) {
      this.lastTurn = turn;
      this.emit('turn', {
        color: turn,
        mine: turn === this.myColor,
        inCheck: this.chess.inCheck(),
        moveNumber: Math.floor(this.game.moves.length / 2) + 1,
      });
    }
  }

  #write(game) {
    const next = {
      ...game,
      rev: (this.game?.rev || game.rev || 0) + 1,
      updatedAt: Date.now(),
    };
    this.net.setState('game', JSON.stringify(next));
    return next;
  }

  /**
   * @returns {'ok'|'promotion'|'illegal'|'not-your-turn'|'pending'|'not-playing'}
   */
  tryMove(from, to, promotion = '') {
    return this.tryColorMove(from, to, promotion, this.myColor);
  }

  /**
   * Same move pipeline for a side controlled by the local bot. The online
   * path never needs this, but it keeps offline and online rules identical.
   */
  tryColorMove(from, to, promotion = '', color = this.myColor) {
    if (!this.chess) return 'not-playing';
    if (this.game?.status !== 'playing') return 'not-playing';
    if (!color || this.chess.turn() !== color) return 'not-your-turn';
    if (this.pending) return 'pending';

    const candidates = this.legalMoves(from).filter((m) => m.to === to);
    if (!candidates.length) return 'illegal';
    if (!promotion && candidates.some((m) => m.promotion)) return 'promotion';

    const test = new Chess(this.chess.fen());
    let move;
    try {
      move = test.move({ from, to, ...(promotion ? { promotion } : {}) });
    } catch {
      return 'illegal';
    }
    if (!move) return 'illegal';

    const outcome = outcomeAfter(test, move.color);
    const now = Date.now();
    const next = {
      ...this.game,
      fen: test.fen(),
      moves: [...this.game.moves, move.san].slice(-MAX_STORED_MOVES),
      lastMove: {
        from: move.from,
        to: move.to,
        san: move.san,
        color: move.color,
        piece: move.piece,
        captured: move.captured || null,
        promotion: move.promotion || null,
        castle: move.isKingsideCastle?.() ? 'k' : move.isQueensideCastle?.() ? 'q' : null,
        enPassant: !!move.isEnPassant?.(),
      },
      status: outcome.status,
      winner: outcome.winner,
      reason: outcome.reason,
      drawOffer: 0,
      turnStartedAt: now,
      updatedAt: now,
      rev: this.game.rev + 1,
    };

    this.pending = true;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      if (!this.pending) return;
      this.pending = false;
      this.emit('change', this.snapshot());
      this.emit('toast', { text: t('The server did not confirm the move. Check your connection.'), type: 'error' });
    }, 4500);

    const sent = this.net.setState('game', JSON.stringify(next));
    if (!sent) {
      this.pending = false;
      return 'not-playing';
    }
    this.emit('pending', { move });
    return 'ok';
  }

  resign() {
    if (!this.isPlaying) return false;
    const winner = this.myColor === 'w' ? 'b' : 'w';
    this.#write({
      ...this.game,
      status: 'resigned',
      winner,
      reason: 'resigned',
      drawOffer: 0,
      updatedAt: Date.now(),
    });
    return true;
  }

  offerDraw() {
    if (!this.isPlaying || this.game.drawOffer) return false;
    this.#write({ ...this.game, drawOffer: this.you, updatedAt: Date.now() });
    this.emit('toast', { text: t('Draw offer sent.'), type: 'ok' });
    return true;
  }

  acceptDraw() {
    if (!this.game || !this.game.drawOffer || this.game.drawOffer === this.you) return false;
    this.#write({
      ...this.game,
      status: 'draw',
      winner: null,
      reason: 'agreement',
      drawOffer: 0,
      updatedAt: Date.now(),
    });
    return true;
  }

  declineDraw() {
    if (!this.game?.drawOffer || this.game.drawOffer === this.you) return false;
    this.#write({ ...this.game, drawOffer: 0, updatedAt: Date.now() });
    return true;
  }

  newGame() {
    if (!this.net.isHost() || !this.game) return false;
    if (this.game.status === 'playing') return false;
    const oldWhite = this.game.whiteId;
    const oldBlack = this.game.blackId;
    const whiteId = oldBlack || oldWhite || this.net.you;
    const blackId = oldWhite && oldWhite !== whiteId ? oldWhite : 0;
    const active = this.net.activePlayers();
    const whiteActive = active.some((p) => p.id === whiteId);
    const blackActive = active.some((p) => p.id === blackId);
    const now = Date.now();
    this.#write({
      ...this.game,
      fen: START_FEN,
      moves: [],
      lastMove: null,
      whiteId: whiteActive ? whiteId : this.net.you,
      blackId: blackActive ? blackId : 0,
      status: whiteActive && blackActive ? 'playing' : 'waiting',
      winner: null,
      reason: null,
      drawOffer: 0,
      startedAt: now,
      turnStartedAt: now,
      updatedAt: now,
    });
    this.resultAnnounced = false;
    return true;
  }

  colorName(color = this.myColor) {
    return color === 'w' ? t('White') : color === 'b' ? t('Black') : t('Spectator');
  }

  opponent() {
    if (!this.game || !this.myColor) return null;
    const id = this.myColor === 'w' ? this.game.blackId : this.game.whiteId;
    return this.net.players.get(id) || null;
  }

  playerFor(color) {
    if (!this.game) return null;
    const id = color === 'w' ? this.game.whiteId : this.game.blackId;
    return id ? this.net.players.get(id) || { id, name: t('Disconnected'), status: 'gone' } : null;
  }

  material() {
    if (!this.chess) return { w: 0, b: 0, diff: 0 };
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
    let w = 0;
    let b = 0;
    for (const row of this.chess.board()) {
      for (const sq of row) {
        if (!sq) continue;
        if (sq.color === 'w') w += values[sq.type];
        else b += values[sq.type];
      }
    }
    return { w, b, diff: w - b };
  }

  capturedBy(color) {
    if (!this.chess) return [];
    const start = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
    const present = { w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } };
    for (const row of this.chess.board()) {
      for (const sq of row) {
        if (sq) present[sq.color][sq.type] += 1;
      }
    }
    const enemy = color === 'w' ? 'b' : 'w';
    const out = [];
    for (const type of ['q', 'r', 'b', 'n', 'p']) {
      const missing = Math.max(0, start[type] - present[enemy][type]);
      for (let i = 0; i < missing; i += 1) out.push({ type, color: enemy });
    }
    return out;
  }

  cloneForHint() {
    return this.chess ? new Chess(this.chess.fen()) : null;
  }

  drawOfferFromOpponent() {
    return !!this.game?.drawOffer && !!this.myColor && this.game.drawOffer !== this.you;
  }

  drawOfferFromMe() {
    return !!this.game?.drawOffer && this.game.drawOffer === this.you;
  }
}
