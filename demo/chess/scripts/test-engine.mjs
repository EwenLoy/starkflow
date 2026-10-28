import { chooseBotMove, findHint, openingName } from '../src/engine.js';
import { Chess } from '../vendor/chess.js/chess.js';

let passed = 0;
const ok = (condition, label) => {
  if (!condition) throw new Error('FAIL: ' + label);
  passed += 1;
  console.log('ok', label);
};

const MATE_IN_ONE = [
  '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
  '6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1',
  '7k/6pp/8/8/8/8/5PPP/R5K1 w - - 0 1',
];

for (const fen of MATE_IN_ONE) {
  for (const level of ['medium', 'master']) {
    const started = Date.now();
    const move = chooseBotMove(fen, level);
    const chess = new Chess(fen);
    chess.move({ from: move.from, to: move.to, promotion: move.promotion || undefined });
    ok(chess.isCheckmate(), `${level} finds mate in one (${move.san}, ${Date.now() - started} ms)`);
  }
}

const FREE_QUEEN = '3r2k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
for (const level of ['medium', 'master']) {
  const move = chooseBotMove(FREE_QUEEN, level);
  ok(move.san.startsWith('Qxd8'), `${level} takes the free queen (${move.san})`);
}

for (const level of ['easy', 'medium', 'master']) {
  const chess = new Chess();
  let plies = 0;
  let slowest = 0;
  const started = Date.now();
  while (plies < 40 && !chess.isGameOver()) {
    const turnStart = Date.now();
    const move = chooseBotMove(chess.fen(), level);
    slowest = Math.max(slowest, Date.now() - turnStart);
    if (!move) throw new Error(`FAIL: ${level} returned no move at ply ${plies + 1}`);
    chess.move({ from: move.from, to: move.to, promotion: move.promotion || undefined });
    plies += 1;
  }
  console.log(`   ${level}: ${plies} plies in ${Date.now() - started} ms, slowest ${slowest} ms`);
  ok(plies >= 20, `${level} plays 40 legal plies`);
}

const mateFen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const hint = findHint(new Chess(mateFen), 3);
ok(hint && hint.from === 'a1' && hint.to === 'a8', `hint finds Ra8# (${hint && hint.san})`);
ok(findHint(new Chess('8/8/4k3/8/8/4K3/8/7R w - - 0 1'), 2) !== null, 'hint works in a rook endgame');
ok(openingName(['e4', 'e5', 'Nf3'], 'ru') === 'Открытый дебют', 'Russian opening name');
ok(openingName(['e4', 'c5'], 'en') === 'Sicilian Defence', 'English opening name');

console.log(`\n${passed} checks passed`);

