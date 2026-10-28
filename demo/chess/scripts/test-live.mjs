import { StarkFlowClient } from '../src/net.js';
import { ChessSession } from '../src/session.js';

const URL = 'wss://starkflow.orkestr.run/ws';
const APP = 'starkflow-chess-e2e';
const LOBBY = 'e2e';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function once(net, type, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const off = net.on(type, (data) => {
      off();
      clearTimeout(timer);
      resolve(data);
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error('timeout waiting for ' + type));
    }, timeout);
  });
}

async function waitUntil(fn, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await wait(50);
  }
  throw new Error('condition timeout');
}

const a = new StarkFlowClient({ url: URL, app: APP, lobby: LOBBY, name: 'Alpha' });
const sa = new ChessSession(a);
const b = new StarkFlowClient({ url: URL, app: APP, lobby: LOBBY, name: 'Beta' });
const sb = new ChessSession(b);
a.on('state.changed', (e) => console.log('A state', e.key, String(e.value).slice(0, 120)));
b.on('state.changed', (e) => console.log('B state', e.key, String(e.value).slice(0, 120)));
a.on('error', (e) => console.log('A err', e));
b.on('error', (e) => console.log('B err', e));

try {
  await a.connect('Alpha');
  console.log('A connected', a.userId.slice(0, 8));
  const roomName = 'e2e-' + Math.random().toString(36).slice(2, 6);
  a.createRoom(roomName, { maxPlayers: 8, emptyTTL: 10 });
  const joinedA = await once(a, 'room.joined');
  console.log('A joined', joinedA.room.id, 'host', joinedA.hostId);
  await waitUntil(() => !!sa.game);
  console.log('A game', sa.game.rev, sa.game.status, 'white', sa.game.whiteId);

  await b.connect('Beta');
  console.log('B connected', b.userId.slice(0, 8));
  b.joinRoom(joinedA.room.id);
  const joinedB = await once(b, 'room.joined');
  console.log('B joined', joinedB.you, 'black?', joinedB.you === 2);
  await waitUntil(() => sa.game?.status === 'playing' && sb.game?.status === 'playing');
  console.log('seats', sa.game.whiteId, sa.game.blackId, 'colors', sa.myColor, sb.myColor);
  if (sa.myColor !== 'w' || sb.myColor !== 'b') throw new Error('unexpected colors');

  const beforeB = sb.game.rev;
  console.log('A moves e4 from rev', sa.game.rev, 'B has rev', sb.game.rev);
  const moved = sa.tryMove('e2', 'e4');
  console.log('A move result', moved, 'pending', sa.pending);
  if (moved !== 'ok') throw new Error('A move failed: ' + moved);
  await waitUntil(() => sb.game?.rev > beforeB && sb.game?.moves.includes('e4'));
  console.log('B received e4', sb.game.fen);

  const beforeA = sa.game.rev;
  const blackMove = sb.tryMove('e7', 'e5');
  console.log('B move result', blackMove, 'pending', sb.pending);
  if (blackMove !== 'ok') throw new Error('B move failed: ' + blackMove);
  await waitUntil(() => sa.game?.rev > beforeA && sa.game?.moves.includes('e5'));
  console.log('A received e5', sa.game.fen);

  if (!sa.game.moves.includes('e4') || !sa.game.moves.includes('e5')) throw new Error('move history missing');
  console.log('state size', JSON.stringify(sa.game).length, 'bytes');

  a.leaveRoom();
  b.leaveRoom();
  await wait(400);
  console.log('E2E OK');
} catch (err) {
  console.error('E2E FAILED', err);
  process.exitCode = 1;
} finally {
  a.disconnect();
  b.disconnect();
  sa.destroy();
  sb.destroy();
  await wait(200);
}
