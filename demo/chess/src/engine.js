const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

// Piece-square tables from White's point of view (a8 … h1).
const PAWN = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const KNIGHT = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];
const BISHOP = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];
const ROOK = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0,
];
const QUEEN = [
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20,
];
const KING = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];
const TABLES = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

const FILES = 'abcdefgh';

function indexOf(square, color) {
  const file = FILES.indexOf(square[0]);
  let rank = Number(square[1]);
  if (color === 'b') rank = 9 - rank;
  return (8 - rank) * 8 + file;
}

function evaluate(chess) {
  if (chess.isCheckmate()) return chess.turn() === 'w' ? -99999 : 99999;
  if (chess.isDraw() || chess.isStalemate()) return 0;
  let score = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const table = TABLES[piece.type];
      const pos = table[indexOf(piece.square, piece.color)];
      const value = VALUE[piece.type] + pos;
      score += piece.color === 'w' ? value : -value;
    }
  }
  return score;
}

function orderMoves(moves) {
  return moves.sort((a, b) => {
    const av = (a.captured ? VALUE[a.captured] : 0) + (a.promotion ? 700 : 0) + (a.san.includes('+') ? 20 : 0);
    const bv = (b.captured ? VALUE[b.captured] : 0) + (b.promotion ? 700 : 0) + (b.san.includes('+') ? 20 : 0);
    return bv - av;
  });
}

function search(chess, depth, alpha, beta, color) {
  if (depth === 0 || chess.isGameOver()) return evaluate(chess) * (color === 'w' ? 1 : -1);
  const moves = orderMoves(chess.moves({ verbose: true }));
  let best = -Infinity;
  for (const move of moves) {
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    const score = -search(chess, depth - 1, -beta, -alpha, color === 'w' ? 'b' : 'w');
    chess.undo();
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best === -Infinity ? evaluate(chess) * (color === 'w' ? 1 : -1) : best;
}

/**
 * A compact depth-3 alpha-beta hint. This is not an opponent — it is just
 * enough to make the “Подсказка” button feel alive and sensible.
 */
export function findHint(chess, depth = 3) {
  if (!chess || chess.isGameOver()) return null;
  const color = chess.turn();
  const moves = orderMoves(chess.moves({ verbose: true }));
  let best = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    const score = -search(chess, depth - 1, -Infinity, Infinity, color === 'w' ? 'b' : 'w');
    chess.undo();
    const jitter = Math.random() * 4;
    if (score + jitter > bestScore) {
      bestScore = score + jitter;
      best = move;
    }
  }
  return best ? { from: best.from, to: best.to, promotion: best.promotion || '', san: best.san } : null;
}

export function openingName(moves) {
  if (!moves.length) return 'Дебют впереди';
  const line = moves.slice(0, 8).join(' ');
  const known = [
    ['e4 e5 Nf3 Nc6 Bb5', 'Испанская партия'],
    ['e4 e5 Nf3 Nc6 Bc4', 'Итальянская партия'],
    ['e4 e5 Nf3 Nc6 d4', 'Шотландская партия'],
    ['e4 e5 Nf3 Nf6', 'Русская партия'],
    ['e4 e5 Nf3 d6', 'Защита Филидора'],
    ['e4 e5 f4', 'Королевский гамбит'],
    ['e4 e5 Nc3', 'Венская партия'],
    ['e4 e5 Bc4', 'Слоновый дебют'],
    ['e4 e5', 'Открытый дебют'],
    ['e4 c5 Nf3 d6', 'Сицилианская защита'],
    ['e4 c5', 'Сицилианская защита'],
    ['e4 c6', 'Защита Каро-Канн'],
    ['e4 e6', 'Французская защита'],
    ['e4 d5', 'Скандинавская защита'],
    ['e4 Nf6', 'Защита Алехина'],
    ['e4 d6', 'Защита Пирца-Уфимцева'],
    ['d4 d5 c4 e6', 'Ферзевый гамбит'],
    ['d4 d5 c4 c6', 'Славянская защита'],
    ['d4 d5 c4 dxc4', 'Принятый ферзевый гамбит'],
    ['d4 d5 c4', 'Ферзевый гамбит'],
    ['d4 Nf6 c4 e6', 'Индийская защита'],
    ['d4 Nf6 c4 g6', 'Староиндийская защита'],
    ['d4 Nf6 c4 e6 Nc3 Bb4', 'Нимцович'],
    ['d4 Nf6 c4 g6 Nc3 d5', 'Грюнфельд'],
    ['d4 Nf6', 'Индийская защита'],
    ['d4 f5', 'Голландская защита'],
    ['d4 d5', 'Закрытый дебют'],
    ['Nf3 d5', 'Дебют Рети'],
    ['Nf3 Nf6', 'Дебют Рети'],
    ['c4', 'Английское начало'],
    ['c4 e5', 'Английское начало'],
    ['d4', 'Дебют ферзевой пешки'],
    ['e4', 'Дебют королевской пешки'],
  ];
  for (const [pattern, name] of known) {
    if (line === pattern || line.startsWith(pattern + ' ')) return name;
  }
  return 'Нестандартное начало';
}
