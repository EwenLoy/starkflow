import { Chess } from '../vendor/chess.js/chess.js';

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
  let whiteBishops = 0;
  let blackBishops = 0;
  const whitePawns = [0, 0, 0, 0, 0, 0, 0, 0];
  const blackPawns = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const table = TABLES[piece.type];
      const pos = table[indexOf(piece.square, piece.color)];
      const value = VALUE[piece.type] + pos;
      score += piece.color === 'w' ? value : -value;
      if (piece.type === 'b') {
        if (piece.color === 'w') whiteBishops += 1;
        else blackBishops += 1;
      }
      if (piece.type === 'p') {
        const file = FILES.indexOf(piece.square[0]);
        if (piece.color === 'w') whitePawns[file] += 1;
        else blackPawns[file] += 1;
      }
    }
  }
  if (whiteBishops >= 2) score += 28;
  if (blackBishops >= 2) score -= 28;
  for (let file = 0; file < 8; file += 1) {
    if (whitePawns[file] > 1) score -= 12 * (whitePawns[file] - 1);
    if (blackPawns[file] > 1) score += 12 * (blackPawns[file] - 1);
    if (whitePawns[file] && !blackPawns[file]) score += 4;
    if (blackPawns[file] && !whitePawns[file]) score -= 4;
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
 * enough to make the “Hint” button feel alive and sensible.
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

const TIMEOUT = Symbol('timeout');

function quiesce(chess, alpha, beta, color, deadline, depth = 0) {
  if (Date.now() > deadline) throw TIMEOUT;
  const side = color === 'w' ? 1 : -1;
  const stand = evaluate(chess) * side;
  if (depth >= 3) return stand;
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  const captures = chess
    .moves({ verbose: true })
    .filter((move) => move.captured || move.promotion);
  orderMoves(captures);
  for (const move of captures) {
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    const score = -quiesce(chess, -beta, -alpha, color === 'w' ? 'b' : 'w', deadline, depth + 1);
    chess.undo();
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function searchTimed(chess, depth, alpha, beta, color, deadline) {
  if (Date.now() > deadline) throw TIMEOUT;
  if (chess.isGameOver()) return evaluate(chess) * (color === 'w' ? 1 : -1);
  if (depth === 0) return quiesce(chess, alpha, beta, color, deadline);
  const moves = orderMoves(chess.moves({ verbose: true }));
  let best = -Infinity;
  for (const move of moves) {
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    const score = -searchTimed(chess, depth - 1, -beta, -alpha, color === 'w' ? 'b' : 'w', deadline);
    chess.undo();
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best === -Infinity ? evaluate(chess) * (color === 'w' ? 1 : -1) : best;
}

function rootSearch(chess, depth, deadline, jitter = 0) {
  const color = chess.turn();
  const moves = orderMoves(chess.moves({ verbose: true }));
  let best = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    let score;
    try {
      score = -searchTimed(chess, depth - 1, -Infinity, Infinity, color === 'w' ? 'b' : 'w', deadline);
    } finally {
      chess.undo();
    }
    if (jitter) score += Math.random() * jitter;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}

function randomMove(chess) {
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  return moves[Math.floor(Math.random() * moves.length)];
}

/**
 * Offline opponent with three personalities. `easy` is deliberately loose,
 * `medium` looks two plies ahead, and `master` searches up to four plies with
 * a short quiescence search and a time budget, all inside a Web Worker.
 */
export function chooseBotMove(fen, level = 'medium') {
  const chess = new Chess(fen);
  if (chess.isGameOver()) return null;
  if (level === 'easy') {
    if (Math.random() < 0.5) {
      const move = randomMove(chess);
      return move ? { from: move.from, to: move.to, promotion: move.promotion || '', san: move.san } : null;
    }
    const best = rootSearch(chess, 1, Date.now() + 450, 90);
    return best ? { from: best.from, to: best.to, promotion: best.promotion || '', san: best.san } : null;
  }

  if (level === 'master') {
    const deadline = Date.now() + 1500;
    let best = null;
    for (let depth = 2; depth <= 4; depth += 1) {
      try {
        const candidate = rootSearch(chess, depth, deadline, 4);
        if (candidate) best = candidate;
      } catch (err) {
        if (err !== TIMEOUT) throw err;
        break;
      }
      if (Date.now() > deadline - 120) break;
    }
    if (best) return { from: best.from, to: best.to, promotion: best.promotion || '', san: best.san };
    const fallback = randomMove(chess);
    return fallback ? { from: fallback.from, to: fallback.to, promotion: fallback.promotion || '', san: fallback.san } : null;
  }

  const best = rootSearch(chess, 2, Date.now() + 900, 18);
  if (best) return { from: best.from, to: best.to, promotion: best.promotion || '', san: best.san };
  const fallback = randomMove(chess);
  return fallback ? { from: fallback.from, to: fallback.to, promotion: fallback.promotion || '', san: fallback.san } : null;
}

export function openingName(moves, locale = 'en') {
  if (!moves.length) return locale === 'ru' ? 'Дебют впереди' : 'Opening ahead';
  const line = moves.slice(0, 8).join(' ');
  const known = [
    ['e4 e5 Nf3 Nc6 Bb5', 'Spanish Game', 'Испанская партия'],
    ['e4 e5 Nf3 Nc6 Bc4', 'Italian Game', 'Итальянская партия'],
    ['e4 e5 Nf3 Nc6 d4', 'Scotch Game', 'Шотландская партия'],
    ['e4 e5 Nf3 Nf6', 'Petrov Defence', 'Русская партия'],
    ['e4 e5 Nf3 d6', 'Philidor Defence', 'Защита Филидора'],
    ['e4 e5 f4', "King's Gambit", 'Королевский гамбит'],
    ['e4 e5 Nc3', 'Vienna Game', 'Венская партия'],
    ['e4 e5 Bc4', "Bishop's Opening", 'Слоновый дебют'],
    ['e4 e5', 'Open Game', 'Открытый дебют'],
    ['e4 c5 Nf3 d6', 'Sicilian Defence', 'Сицилианская защита'],
    ['e4 c5', 'Sicilian Defence', 'Сицилианская защита'],
    ['e4 c6', 'Caro-Kann Defence', 'Защита Каро-Канн'],
    ['e4 e6', 'French Defence', 'Французская защита'],
    ['e4 d5', 'Scandinavian Defence', 'Скандинавская защита'],
    ['e4 Nf6', 'Alekhine Defence', 'Защита Алехина'],
    ['e4 d6', 'Pirc Defence', 'Защита Пирца-Уфимцева'],
    ['d4 d5 c4 e6', "Queen's Gambit", 'Ферзевый гамбит'],
    ['d4 d5 c4 c6', 'Slav Defence', 'Славянская защита'],
    ['d4 d5 c4 dxc4', "Queen's Gambit Accepted", 'Принятый ферзевый гамбит'],
    ['d4 d5 c4', "Queen's Gambit", 'Ферзевый гамбит'],
    ['d4 Nf6 c4 e6', 'Indian Defence', 'Индийская защита'],
    ['d4 Nf6 c4 g6', "King's Indian Defence", 'Староиндийская защита'],
    ['d4 Nf6 c4 e6 Nc3 Bb4', 'Nimzo-Indian Defence', 'Нимцович'],
    ['d4 Nf6 c4 g6 Nc3 d5', 'Grünfeld Defence', 'Грюнфельд'],
    ['d4 Nf6', 'Indian Defence', 'Индийская защита'],
    ['d4 f5', 'Dutch Defence', 'Голландская защита'],
    ['d4 d5', 'Closed Game', 'Закрытый дебют'],
    ['Nf3 d5', 'Réti Opening', 'Дебют Рети'],
    ['Nf3 Nf6', 'Réti Opening', 'Дебют Рети'],
    ['c4', 'English Opening', 'Английское начало'],
    ['c4 e5', 'English Opening', 'Английское начало'],
    ['d4', "Queen's Pawn Opening", 'Дебют ферзевой пешки'],
    ['e4', "King's Pawn Opening", 'Дебют королевской пешки'],
  ];
  for (const [pattern, en, ruName] of known) {
    if (line === pattern || line.startsWith(pattern + ' ')) return locale === 'ru' ? ruName : en;
  }
  return locale === 'ru' ? 'Нестандартное начало' : 'Irregular Opening';
}
