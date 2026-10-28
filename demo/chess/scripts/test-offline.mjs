import { LocalNet } from '../src/offline.js';
import { ChessSession, START_FEN } from '../src/session.js';
import { chooseBotMove, findHint, openingName } from '../src/engine.js';
import { Chess } from '../vendor/chess.js/chess.js';

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (condition, label) => {
  if (!condition) throw new Error('FAIL: ' + label);
  passed += 1;
  console.log('ok', label);
};

async function playGame(playerColor) {
  const net = new LocalNet({ playerName: 'Tester', botName: 'Maestro', playerColor });
  const session = new ChessSession(net);
  const events = [];
  session.on('move', (m) => events.push(m.move));
  session.on('result', () => events.push({ result: true }));
  net.start();
  await wait();
  ok(session.game?.status === 'playing', `${playerColor}: local game started`);
  ok(session.myColor === playerColor, `${playerColor}: player side is correct`);
  const botColor = playerColor === 'w' ? 'b' : 'w';
  if (session.chess.turn() === botColor) {
    const bot = chooseBotMove(session.chess.fen(), 'easy');
    ok(bot, 'bot returns a move');
    const result = session.tryColorMove(bot.from, bot.to, bot.promotion || '', botColor);
    ok(result === 'ok', 'bot move accepted');
    await wait();
  }
  ok(session.chess.turn() === playerColor, 'player turn after bot');
  const moves = session.chess.moves({ verbose: true });
  const whiteMove = moves.find((m) => m.from === 'e2' && m.to === 'e4');
  if (whiteMove) {
    ok(session.tryMove('e2', 'e4') === 'ok', 'player e4 accepted');
    await wait();
    ok(session.game.moves.includes('e4'), 'e4 in history');
  }
  session.destroy();
  net.destroy();
}

await playGame('w');
await playGame('b');

const c = new Chess(START_FEN);
for (const level of ['easy', 'medium', 'master']) {
  const started = Date.now();
  const move = chooseBotMove(c.fen(), level);
  ok(move?.from && move?.to, `${level} bot move`);
  console.log(`   ${level}: ${move.san} in ${Date.now() - started} ms`);
}
ok(findHint(c, 2)?.san, 'hint still works');
ok(openingName(['e4', 'e5', 'Nf3'], 'ru') === 'Открытый дебют', 'Russian opening');
console.log(`\n${passed} checks passed`);
