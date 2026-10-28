import { StarkFlowClient } from '../src/net.js';
import { ChessSession } from '../src/session.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(String(key), String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const URL = process.env.STARKFLOW_URL || 'ws://127.0.0.1:8099/ws';
const APP = 'starkflow-chess-resume';
const LOBBY = 'resume';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function once(net, types, timeout = 12000) {
  const wanted = [].concat(types);
  return new Promise((resolve, reject) => {
    const offs = wanted.map((type) =>
      net.on(type, (data) => {
        for (const off of offs) off();
        clearTimeout(timer);
        resolve({ type, data });
      }),
    );
    const timer = setTimeout(() => {
      for (const off of offs) off();
      reject(new Error('timeout waiting for ' + wanted.join('/')));
    }, timeout);
  });
}

async function waitUntil(fn, timeout = 12000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await wait(50);
  }
  throw new Error('timeout: ' + label);
}

async function lostTable() {
  const net = new StarkFlowClient({ url: URL, app: APP + '-lost', lobby: LOBBY, name: 'Gamma', storage: memoryStorage() });
  await net.connect('Gamma');
  net.createRoom('gone-' + Math.random().toString(36).slice(2, 6), { maxPlayers: 8, emptyTTL: 1 });
  const joined = await once(net, 'room.joined');
  const roomId = joined.data.room.id;
  net.disconnect();
  await wait(6000);
  net.manualRetry();
  const event = await once(net, ['room.joined', 'room.missing'], 15000);
  const status = { event: event.type, room: net.room ? net.room.id : null, want: net.wantRoom };
  net.disconnect();
  if (event.type !== 'room.missing' || status.room !== null || status.want !== null) {
    throw new Error('a closed table must drop the stale room: ' + JSON.stringify({ roomId, ...status }));
  }
  console.log('closed table handled, room', roomId, '->', status);
}

async function reloadTable() {
  const app = APP + '-reload';
  const tab = memoryStorage();
  const first = new StarkFlowClient({ url: URL, app, lobby: LOBBY, name: 'Delta', storage: tab });
  const sf = new ChessSession(first);
  const guest = new StarkFlowClient({ url: URL, app, lobby: LOBBY, name: 'Epsilon', storage: memoryStorage() });
  const sg = new ChessSession(guest);
  let again = null;
  let sa2 = null;
  first.on('error', (e) => console.log('first err', e));
  guest.on('error', (e) => console.log('guest err', e));
  try {
    await first.connect('Delta');
    first.createRoom('reload-' + Math.random().toString(36).slice(2, 6), { maxPlayers: 8, emptyTTL: 300 });
    const joined = await once(first, 'room.joined');
    const roomId = joined.data.room.id;
    await waitUntil(() => !!sf.game, 4000, 'Delta game');
    const seat = first.you;

    await guest.connect('Epsilon');
    guest.joinRoom(roomId);
    await once(guest, 'room.joined');
    await waitUntil(() => sf.game?.status === 'playing' && sg.game?.status === 'playing', 4000, 'reload playing');

    first.disconnect();
    await wait(600);
    again = new StarkFlowClient({ url: URL, app, lobby: LOBBY, name: 'Delta', storage: tab });
    sa2 = new ChessSession(again);
    again.on('error', (e) => console.log('again err', e));
    await again.connect('Delta');
    again.joinRoom(roomId);
    const back = await once(again, 'room.joined', 8000);
    await wait(300);
    const out = { seat, you: again.you, resumed: !!back.data.resumed, color: sa2.myColor, status: sa2.game?.status };
    if (out.you !== out.seat || !out.resumed || out.color !== 'w' || out.status !== 'playing') {
      throw new Error('a reloaded tab lost the table: ' + JSON.stringify({ roomId, ...out }));
    }
    console.log('reload kept the seat', out);
  } finally {
    again?.leaveRoom();
    guest.leaveRoom();
    first.disconnect();
    again?.disconnect();
    guest.disconnect();
    sa2?.destroy();
    sg.destroy();
    sf.destroy();
    await wait(400);
  }
}

const a = new StarkFlowClient({ url: URL, app: APP, lobby: LOBBY, name: 'Alpha', storage: memoryStorage() });
const sa = new ChessSession(a);
const b = new StarkFlowClient({ url: URL, app: APP, lobby: LOBBY, name: 'Beta', storage: memoryStorage() });
const sb = new ChessSession(b);

try {
  await a.connect('Alpha');
  a.createRoom('resume-' + Math.random().toString(36).slice(2, 6), { maxPlayers: 8, emptyTTL: 300 });
  const joined = await once(a, 'room.joined');
  const roomId = joined.data.room.id;
  await waitUntil(() => !!sa.game, 4000, 'A game');
  const seatA = a.you;
  const userA = a.userId;

  await b.connect('Beta');
  b.joinRoom(roomId);
  await once(b, 'room.joined');
  await waitUntil(() => sa.game?.status === 'playing' && sb.game?.status === 'playing', 4000, 'playing');
  if (sa.tryMove('e2', 'e4') !== 'ok') throw new Error('A cannot move before the drop');
  await waitUntil(() => sb.game?.moves.includes('e4'), 4000, 'B sees e4');
  console.log('before drop: seats', sa.game.whiteId, sa.game.blackId, 'A player', seatA);

  a.disconnect();
  await wait(7000);
  console.log('room alive after the player timeout:', b.room?.id, 'players', b.playerList().map((p) => [p.id, p.name]));

  a.manualRetry();
  await once(a, 'room.joined', 15000);
  await wait(300);
  console.log('after resume: you', a.you, 'seat was', seatA, 'color', sa.myColor, 'status', sa.game?.status);
  if (a.userId !== userA) throw new Error('the identity was not kept across the reconnect');
  if (sa.game?.status !== 'playing') throw new Error('the game was abandoned on a connection loss: ' + sa.game?.status);
  if (sa.myColor !== 'w') throw new Error('the returning player lost his colour: ' + sa.myColor);
  await waitUntil(() => sb.game.whiteId === a.you, 5000, 'the host moves the white seat to the new player id');
  console.log('seat moved to player', a.you, 'whiteId', sb.game.whiteId);

  const before = sa.game.rev;
  if (sb.tryMove('e7', 'e5') !== 'ok') throw new Error('B cannot move after the drop');
  await waitUntil(() => sa.game?.moves.includes('e5'), 4000, 'A sees e5');
  const moved = sa.tryMove('g1', 'f3');
  if (moved !== 'ok') throw new Error('A cannot move after the resume: ' + moved);
  await waitUntil(() => sb.game?.moves.includes('Nf3'), 4000, 'B sees Nf3');
  console.log('resume OK, rev', before, '->', sa.game.rev);
  a.leaveRoom();
  b.leaveRoom();
  await wait(400);

  await lostTable();
  await reloadTable();
  console.log('RESUME OK');
} catch (err) {
  console.error('RESUME FAILED', err);
  process.exitCode = 1;
} finally {
  a.disconnect();
  b.disconnect();
  sa.destroy();
  sb.destroy();
  await wait(200);
}
