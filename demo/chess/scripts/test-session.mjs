import { ChessSession, START_FEN } from '../src/session.js';
import { findHint, openingName } from '../src/engine.js';
import { Chess } from '../vendor/chess.js/chess.js';

class MockNet {
  constructor() {
    this.handlers = new Map();
    this.state = {};
    this.players = new Map();
    this.room = null;
    this.you = 0;
    this.hostId = 0;
    this.writes = [];
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }
  emit(type, detail) {
    for (const fn of this.handlers.get(type) || []) fn(detail);
  }
  isHost() {
    return this.you === this.hostId;
  }
  playerList() {
    return [...this.players.values()];
  }
  activePlayers() {
    return this.playerList().filter((p) => p.status !== 'suspended');
  }
  setState(key, value) {
    const old = this.state[key];
    this.writes.push({ key, value });
    this.state[key] = value;
    queueMicrotask(() => this.emit('state.changed', { key, value, old, by: this.you }));
    return true;
  }
  open(room, you, hostId, players, state = {}) {
    this.room = room;
    this.you = you;
    this.hostId = hostId;
    this.players = new Map(players.map((p) => [p.id, p]));
    this.state = state;
    this.emit('room.joined', { room, you, hostId, players, state });
  }
  joinPlayer(player) {
    this.players.set(player.id, player);
    this.emit('players.changed', { players: this.playerList(), joined: player.id });
  }
}

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(condition, label) {
  if (!condition) throw new Error('FAIL: ' + label);
  passed += 1;
  console.log('ok', label);
}
function game(mock) {
  return JSON.parse(mock.state.game);
}

async function testInitializationAndSeats() {
  const net = new MockNet();
  const session = new ChessSession(net);
  const room = { id: 'room1', name: 'Test' };
  net.open(room, 1, 1, [{ id: 1, name: 'A', status: 'active' }]);
  await wait();
  ok(net.writes.length === 1, 'host writes initial game');
  let g = game(net);
  ok(g.status === 'waiting' && g.whiteId === 1, 'initial state is waiting with host as white');
  net.joinPlayer({ id: 2, name: 'B', status: 'active' });
  await wait();
  g = game(net);
  ok(g.status === 'playing' && g.blackId === 2, 'second player is seated as black');
  ok(session.myColor === 'w', 'host sees itself as white');
  session.destroy();
}

async function testMovesAndOutcome() {
  const net = new MockNet();
  const session = new ChessSession(net);
  const g = {
    v: 1, rev: 1, fen: START_FEN, moves: [], lastMove: null,
    whiteId: 1, blackId: 2, status: 'playing', winner: null, reason: null, drawOffer: 0,
    createdAt: Date.now(), startedAt: Date.now(), updatedAt: Date.now(), turnStartedAt: Date.now(),
  };
  net.open({ id: 'room2', name: 'Moves' }, 1, 1, [
    { id: 1, name: 'A', status: 'active' },
    { id: 2, name: 'B', status: 'active' },
  ], { game: JSON.stringify(g) });
  await wait();
  ok(session.myColor === 'w' && session.chess.turn() === 'w', 'white to move');
  ok(session.tryMove('e2', 'e4') === 'ok', 'e2-e4 sent');
  await wait();
  ok(session.chess.fen().startsWith('rnbqkbnr/pppppppp/8/8/4P3'), 'e2-e4 applied');
  ok(session.chess.turn() === 'b', 'black to move');
  ok(session.tryMove('e7', 'e5') === 'not-your-turn', 'cannot move for opponent');
  // Fast-forward to a short mate using the shared state, as if black replies.
  const line = ['e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  for (let i = 0; i < line.length; i += 1) {
    const m = line[i];
    if (i === 0) {
      // black moves are written by the opponent session; emulate via the mock.
      const current = game(net);
      const test = new Chess(current.fen);
      const move = test.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
      net.emit('state.changed', {
        key: 'game',
        value: JSON.stringify({ ...current, rev: current.rev + 1, fen: test.fen(), moves: [...current.moves, move.san], lastMove: { from: move.from, to: move.to, san: move.san, color: move.color } }),
        old: JSON.stringify(current),
      });
      await wait();
      continue;
    }
    if (session.chess.turn() !== session.myColor) {
      const current = game(net);
      const test = new Chess(current.fen);
      const move = test.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
      net.emit('state.changed', {
        key: 'game',
        value: JSON.stringify({ ...current, rev: current.rev + 1, fen: test.fen(), moves: [...current.moves, move.san], lastMove: { from: move.from, to: move.to, san: move.san, color: move.color } }),
        old: JSON.stringify(current),
      });
      await wait();
    } else {
      ok(session.tryMove(m.slice(0, 2), m.slice(2, 4)) === 'ok', 'white move ' + m);
      await wait();
    }
  }
  ok(session.game.status === 'checkmate', 'checkmate detected');
  ok(session.game.winner === 'w', 'white wins');
  session.destroy();
}

async function testOfferDrawAndResign() {
  const net = new MockNet();
  const session = new ChessSession(net);
  const g = {
    v: 1, rev: 1, fen: START_FEN, moves: [], lastMove: null,
    whiteId: 1, blackId: 2, status: 'playing', winner: null, reason: null, drawOffer: 0,
    createdAt: Date.now(), startedAt: Date.now(), updatedAt: Date.now(), turnStartedAt: Date.now(),
  };
  net.open({ id: 'room3', name: 'Draw' }, 2, 1, [
    { id: 1, name: 'A', status: 'active' },
    { id: 2, name: 'B', status: 'active' },
  ], { game: JSON.stringify(g) });
  await wait();
  ok(session.myColor === 'b', 'guest is black');
  session.offerDraw();
  await wait();
  ok(game(net).drawOffer === 2, 'draw offer stored');
  ok(session.drawOfferFromMe(), 'own offer is recognised');
  // switch identity by simulating the opponent's session would be a separate client;
  // instead apply a white-side acceptance directly.
  const accepted = { ...game(net), status: 'draw', winner: null, reason: 'agreement', drawOffer: 0, rev: game(net).rev + 1 };
  net.emit('state.changed', { key: 'game', value: JSON.stringify(accepted), old: 'x' });
  await wait();
  ok(session.game.status === 'draw' && session.game.reason === 'agreement', 'draw accepted');
  session.destroy();
}

async function testRulesEngine() {
  const { Chess } = await import('../vendor/chess.js/chess.js');
  const c = new Chess();
  ok(findHint(c, 2)?.san, 'hint returns a move');
  ok(openingName(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']) === 'Итальянская партия', 'opening detection');
}

await testInitializationAndSeats();
await testMovesAndOutcome();
await testOfferDrawAndResign();
await testRulesEngine();
console.log(`\n${passed} checks passed`);
