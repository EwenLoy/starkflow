import { Chess } from '../vendor/chess.js/chess.js';

const WHITE = 0;
const BLACK = 1;
const PAWN = 1;
const KNIGHT = 2;
const BISHOP = 3;
const ROOK = 4;
const QUEEN = 5;
const KING = 6;

const MATE = 30000;
const INFINITY = 100000;
const TIMEOUT = { timeout: true };

const CASTLE_WK = 1;
const CASTLE_WQ = 2;
const CASTLE_BK = 4;
const CASTLE_BQ = 8;

const MOVE_EN_PASSANT = 1;
const MOVE_CASTLE = 2;
const MOVE_DOUBLE = 4;

const KNIGHT_STEPS = [33, 31, 18, 14, -33, -31, -18, -14];
const BISHOP_STEPS = [17, 15, -17, -15];
const ROOK_STEPS = [16, 1, -1, -16];
const KING_STEPS = [17, 16, 15, 1, -1, -15, -16, -17];

const FILES = 'abcdefgh';
const PROMOTION_LETTERS = { 2: 'n', 3: 'b', 4: 'r', 5: 'q' };

const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());
const onBoard = (square) => (square & 0x88) === 0;
const squareOf = (name) => (Number(name[1]) - 1) * 16 + FILES.indexOf(name[0]);
const nameOf = (square) => `${FILES[square & 7]}${(square >> 4) + 1}`;

const packMove = (from, to, promotion = 0, flags = 0) => from | (to << 7) | (promotion << 14) | (flags << 17);
const moveFrom = (move) => move & 0x7f;
const moveTo = (move) => (move >> 7) & 0x7f;
const movePromotion = (move) => (move >> 14) & 7;
const moveFlags = (move) => (move >> 17) & 0xf;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const seededRandom = mulberry32(0x1f123bb5);
const pieceLo = new Int32Array(16 * 128);
const pieceHi = new Int32Array(16 * 128);
for (let i = 0; i < pieceLo.length; i += 1) {
  pieceLo[i] = seededRandom() | 0;
  pieceHi[i] = seededRandom() | 0;
}
const castleLo = new Int32Array(16);
const castleHi = new Int32Array(16);
for (let i = 0; i < 16; i += 1) {
  castleLo[i] = seededRandom() | 0;
  castleHi[i] = seededRandom() | 0;
}
const epLo = new Int32Array(128);
const epHi = new Int32Array(128);
for (let i = 0; i < 128; i += 1) {
  epLo[i] = seededRandom() | 0;
  epHi[i] = seededRandom() | 0;
}
const sideLo = seededRandom() | 0;
const sideHi = seededRandom() | 0;

function rookRightsMask(square) {
  if (square === 0) return ~CASTLE_WQ;
  if (square === 7) return ~CASTLE_WK;
  if (square === 112) return ~CASTLE_BQ;
  if (square === 119) return ~CASTLE_BK;
  return 15;
}


const PIECE_LETTERS = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

class Position {
  constructor(fen) {
    this.board = new Int8Array(128);
    this.kings = new Int32Array(2);
    this.undoStack = [];
    this.keyLo = new Int32Array(2048);
    this.keyHi = new Int32Array(2048);
    this.keyCount = 0;
    this.castle = 0;
    this.ep = -1;
    this.half = 0;
    this.side = WHITE;
    this.hashLo = 0;
    this.hashHi = 0;
    this.setup(fen);
  }

  setup(fen) {
    const parts = String(fen).trim().split(/\s+/);
    const rows = parts[0].split('/');
    this.board.fill(0);
    for (let row = 0; row < 8; row += 1) {
      const rank = 7 - row;
      let file = 0;
      for (const letter of rows[row] || '') {
        if (letter >= '1' && letter <= '8') {
          file += Number(letter);
          continue;
        }
        const type = PIECE_LETTERS[letter.toLowerCase()] || 0;
        if (!type) continue;
        const color = letter === letter.toUpperCase() ? WHITE : BLACK;
        const square = rank * 16 + file;
        this.board[square] = type | (color << 3);
        if (type === KING) this.kings[color] = square;
        file += 1;
      }
    }
    this.side = parts[1] === 'b' ? BLACK : WHITE;
    this.castle = 0;
    const rights = parts[2] || '-';
    if (rights.includes('K')) this.castle |= CASTLE_WK;
    if (rights.includes('Q')) this.castle |= CASTLE_WQ;
    if (rights.includes('k')) this.castle |= CASTLE_BK;
    if (rights.includes('q')) this.castle |= CASTLE_BQ;
    this.ep = parts[3] && parts[3] !== '-' ? squareOf(parts[3]) : -1;
    this.half = Number(parts[4]) || 0;
    this.hashLo = 0;
    this.hashHi = 0;
    for (let square = 0; square < 128; square += 1) {
      if (!onBoard(square)) {
        square += 7;
        continue;
      }
      const piece = this.board[square];
      if (!piece) continue;
      this.hashLo ^= pieceLo[piece * 128 + square];
      this.hashHi ^= pieceHi[piece * 128 + square];
    }
    if (this.side === BLACK) {
      this.hashLo ^= sideLo;
      this.hashHi ^= sideHi;
    }
    this.hashLo ^= castleLo[this.castle];
    this.hashHi ^= castleHi[this.castle];
    if (this.ep >= 0) {
      this.hashLo ^= epLo[this.ep];
      this.hashHi ^= epHi[this.ep];
    }
    this.keyCount = 0;
    this.pushKey();
  }

  pushKey() {
    this.keyCount += 1;
    this.keyLo[this.keyCount] = this.hashLo;
    this.keyHi[this.keyCount] = this.hashHi;
  }

  inCheck(color = this.side) {
    return isAttacked(this, this.kings[color], color ^ 1);
  }

  isRepetition() {
    const stop = Math.max(1, this.keyCount - this.half);
    for (let i = this.keyCount - 2; i >= stop; i -= 2) {
      if (this.keyLo[i] === this.hashLo && this.keyHi[i] === this.hashHi) return true;
    }
    return false;
  }

  has(type) {
    for (let square = 0; square < 128; square += 1) {
      if (!onBoard(square)) {
        square += 7;
        continue;
      }
      const piece = this.board[square];
      if (piece && (piece & 7) === type && piece >> 3 === this.side) return true;
    }
    return false;
  }

  make(move) {
    const board = this.board;
    const from = moveFrom(move);
    const to = moveTo(move);
    const piece = board[from];
    const color = piece >> 3;
    const type = piece & 7;
    const flags = moveFlags(move);
    const promotion = movePromotion(move);
    let victim = 0;
    let victimSquare = -1;
    if (flags & MOVE_EN_PASSANT) {
      victimSquare = to + (color === WHITE ? -16 : 16);
      victim = board[victimSquare];
    } else if (board[to]) {
      victim = board[to];
      victimSquare = to;
    }
    this.undoStack.push({
      move,
      piece,
      victim,
      victimSquare,
      castle: this.castle,
      ep: this.ep,
      half: this.half,
      hashLo: this.hashLo,
      hashHi: this.hashHi,
      keyCount: this.keyCount,
      nullMove: false,
    });

    let lo = this.hashLo;
    let hi = this.hashHi;
    if (this.ep >= 0) {
      lo ^= epLo[this.ep];
      hi ^= epHi[this.ep];
    }
    lo ^= castleLo[this.castle];
    hi ^= castleHi[this.castle];
    if (victim) {
      board[victimSquare] = 0;
      lo ^= pieceLo[victim * 128 + victimSquare];
      hi ^= pieceHi[victim * 128 + victimSquare];
    }

    board[from] = 0;
    const placed = promotion ? promotion | (color << 3) : piece;
    board[to] = placed;
    lo ^= pieceLo[piece * 128 + from] ^ pieceLo[placed * 128 + to];
    hi ^= pieceHi[piece * 128 + from] ^ pieceHi[placed * 128 + to];
    if (type === KING) this.kings[color] = to;

    if (flags & MOVE_CASTLE) {
      const kingSide = (to & 7) === 6;
      const rookFrom = color === WHITE ? (kingSide ? 7 : 0) : kingSide ? 119 : 112;
      const rookTo = color === WHITE ? (kingSide ? 5 : 3) : kingSide ? 117 : 115;
      const rook = board[rookFrom];
      board[rookFrom] = 0;
      board[rookTo] = rook;
      lo ^= pieceLo[rook * 128 + rookFrom] ^ pieceLo[rook * 128 + rookTo];
      hi ^= pieceHi[rook * 128 + rookFrom] ^ pieceHi[rook * 128 + rookTo];
    }

    let castle = this.castle;
    if (type === KING) castle &= color === WHITE ? ~(CASTLE_WK | CASTLE_WQ) : ~(CASTLE_BK | CASTLE_BQ);
    if (type === ROOK) castle &= rookRightsMask(from);
    if (victim && (victim & 7) === ROOK) castle &= rookRightsMask(victimSquare);
    this.castle = castle;
    lo ^= castleLo[castle];
    hi ^= castleHi[castle];

    this.ep = flags & MOVE_DOUBLE ? (from + to) >> 1 : -1;
    if (this.ep >= 0) {
      lo ^= epLo[this.ep];
      hi ^= epHi[this.ep];
    }
    this.half = type === PAWN || victim ? 0 : this.half + 1;
    this.side ^= 1;
    this.hashLo = lo ^ sideLo;
    this.hashHi = hi ^ sideHi;
    this.pushKey();
  }

  unmake() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    if (entry.nullMove) {
      this.ep = entry.ep;
      this.half = entry.half;
      this.castle = entry.castle;
      this.hashLo = entry.hashLo;
      this.hashHi = entry.hashHi;
      this.keyCount = entry.keyCount;
      this.side ^= 1;
      return;
    }
    const board = this.board;
    const move = entry.move;
    const from = moveFrom(move);
    const to = moveTo(move);
    const piece = entry.piece;
    const color = piece >> 3;
    board[from] = piece;
    board[to] = 0;
    if (entry.victim) board[entry.victimSquare] = entry.victim;
    if ((piece & 7) === KING) this.kings[color] = from;
    if (moveFlags(move) & MOVE_CASTLE) {
      const kingSide = (to & 7) === 6;
      const rookFrom = color === WHITE ? (kingSide ? 7 : 0) : kingSide ? 119 : 112;
      const rookTo = color === WHITE ? (kingSide ? 5 : 3) : kingSide ? 117 : 115;
      board[rookFrom] = board[rookTo];
      board[rookTo] = 0;
    }
    this.castle = entry.castle;
    this.ep = entry.ep;
    this.half = entry.half;
    this.hashLo = entry.hashLo;
    this.hashHi = entry.hashHi;
    this.keyCount = entry.keyCount;
    this.side ^= 1;
  }

  makeNull() {
    this.undoStack.push({
      move: 0,
      piece: 0,
      victim: 0,
      victimSquare: -1,
      castle: this.castle,
      ep: this.ep,
      half: this.half,
      hashLo: this.hashLo,
      hashHi: this.hashHi,
      keyCount: this.keyCount,
      nullMove: true,
    });
    let lo = this.hashLo;
    let hi = this.hashHi;
    if (this.ep >= 0) {
      lo ^= epLo[this.ep];
      hi ^= epHi[this.ep];
    }
    this.ep = -1;
    this.half += 1;
    this.side ^= 1;
    this.hashLo = lo ^ sideLo;
    this.hashHi = hi ^ sideHi;
    this.pushKey();
  }
}

function generateMoves(pos, out, capturesOnly = false) {
  out.length = 0;
  const board = pos.board;
  const side = pos.side;
  for (let rank = 0; rank < 8; rank += 1) {
    const base = rank * 16;
    for (let file = 0; file < 8; file += 1) {
      const from = base + file;
      const piece = board[from];
      if (!piece || piece >> 3 !== side) continue;
      const type = piece & 7;
      if (type === PAWN) {
        const forward = side === WHITE ? 16 : -16;
        const startRank = side === WHITE ? 1 : 6;
        const lastRank = side === WHITE ? 7 : 0;
        const one = from + forward;
        if (onBoard(one) && !board[one]) {
          if ((one >> 4) === lastRank) {
            out.push(packMove(from, one, QUEEN), packMove(from, one, ROOK), packMove(from, one, BISHOP), packMove(from, one, KNIGHT));
          } else if (!capturesOnly) {
            out.push(packMove(from, one));
            if (rank === startRank && !board[from + forward * 2]) out.push(packMove(from, from + forward * 2, 0, MOVE_DOUBLE));
          }
        }
        for (let i = 0; i < 2; i += 1) {
          const to = from + forward + (i === 0 ? -1 : 1);
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target && target >> 3 !== side) {
            if ((to >> 4) === lastRank) {
              out.push(packMove(from, to, QUEEN), packMove(from, to, ROOK), packMove(from, to, BISHOP), packMove(from, to, KNIGHT));
            } else {
              out.push(packMove(from, to));
            }
          } else if (!target && to === pos.ep) {
            out.push(packMove(from, to, 0, MOVE_EN_PASSANT));
          }
        }
        continue;
      }
      if (type === KNIGHT || type === KING) {
        const steps = type === KNIGHT ? KNIGHT_STEPS : KING_STEPS;
        for (const step of steps) {
          const to = from + step;
          if (!onBoard(to)) continue;
          const target = board[to];
          if (target && target >> 3 === side) continue;
          if (capturesOnly && !target) continue;
          out.push(packMove(from, to));
        }
        if (!capturesOnly && type === KING) {
          if (side === WHITE) {
            if ((pos.castle & CASTLE_WK) && !board[5] && !board[6] && !isAttacked(pos, 4, BLACK) && !isAttacked(pos, 5, BLACK)) {
              out.push(packMove(4, 6, 0, MOVE_CASTLE));
            }
            if ((pos.castle & CASTLE_WQ) && !board[3] && !board[2] && !board[1] && !isAttacked(pos, 4, BLACK) && !isAttacked(pos, 3, BLACK)) {
              out.push(packMove(4, 2, 0, MOVE_CASTLE));
            }
          } else {
            if ((pos.castle & CASTLE_BK) && !board[117] && !board[118] && !isAttacked(pos, 116, WHITE) && !isAttacked(pos, 117, WHITE)) {
              out.push(packMove(116, 118, 0, MOVE_CASTLE));
            }
            if ((pos.castle & CASTLE_BQ) && !board[115] && !board[114] && !board[113] && !isAttacked(pos, 116, WHITE) && !isAttacked(pos, 115, WHITE)) {
              out.push(packMove(116, 114, 0, MOVE_CASTLE));
            }
          }
        }
        continue;
      }
      const steps = type === BISHOP ? BISHOP_STEPS : type === ROOK ? ROOK_STEPS : KING_STEPS;
      for (const step of steps) {
        let to = from + step;
        while (onBoard(to)) {
          const target = board[to];
          if (target) {
            if (target >> 3 !== side) out.push(packMove(from, to));
            break;
          }
          if (!capturesOnly) out.push(packMove(from, to));
          to += step;
        }
      }
    }
  }
  return out;
}

function isAttacked(pos, square, bySide) {
  const board = pos.board;
  if (bySide === WHITE) {
    const pawn = PAWN;
    if (onBoard(square - 15) && board[square - 15] === pawn) return true;
    if (onBoard(square - 17) && board[square - 17] === pawn) return true;
  } else {
    const pawn = PAWN | (BLACK << 3);
    if (onBoard(square + 15) && board[square + 15] === pawn) return true;
    if (onBoard(square + 17) && board[square + 17] === pawn) return true;
  }
  const knight = KNIGHT | (bySide << 3);
  for (const step of KNIGHT_STEPS) {
    const to = square + step;
    if (onBoard(to) && board[to] === knight) return true;
  }
  const king = KING | (bySide << 3);
  for (const step of KING_STEPS) {
    const to = square + step;
    if (onBoard(to) && board[to] === king) return true;
  }
  const bishop = BISHOP | (bySide << 3);
  const queen = QUEEN | (bySide << 3);
  const rook = ROOK | (bySide << 3);
  for (const step of BISHOP_STEPS) {
    let to = square + step;
    while (onBoard(to)) {
      const code = board[to];
      if (code) {
        if (code === bishop || code === queen) return true;
        break;
      }
      to += step;
    }
  }
  for (const step of ROOK_STEPS) {
    let to = square + step;
    while (onBoard(to)) {
      const code = board[to];
      if (code) {
        if (code === rook || code === queen) return true;
        break;
      }
      to += step;
    }
  }
  return false;
}

function hasLegalMove(pos) {
  const moves = generateMoves(pos, []);
  for (const move of moves) {
    pos.make(move);
    const legal = !isAttacked(pos, pos.kings[pos.side ^ 1], pos.side);
    pos.unmake();
    if (legal) return true;
  }
  return false;
}

function moveIsQuiet(pos, move) {
  if (pos.board[moveTo(move)]) return false;
  if (movePromotion(move)) return false;
  return !(moveFlags(move) & MOVE_EN_PASSANT);
}

export function findHint(chess, depth = 3) {
  if (!chess || chess.isGameOver()) return null;
  const fen = chess.fen();
  const { result } = searchBest(fen, { maxDepth: Math.max(2, depth), timeMs: 550, tolerance: 0, width: 1, blunder: 0 });
  if (!result) return null;
  return describe(fen, result.move);
}

const PIECE_VALUE = [0, 100, 320, 330, 500, 900, 0];

const PASSED_MG = [0, 4, 10, 20, 36, 60, 95, 0];
const PASSED_EG = [0, 8, 18, 34, 58, 92, 140, 0];

const PAWN_PST = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const PAWN_PST_EG = [
  0, 0, 0, 0, 0, 0, 0, 0,
  90, 90, 90, 90, 90, 90, 90, 90,
  55, 55, 55, 55, 55, 55, 55, 55,
  30, 30, 30, 30, 30, 30, 30, 30,
  16, 16, 16, 16, 16, 16, 16, 16,
  6, 6, 6, 6, 6, 6, 6, 6,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const KNIGHT_PST = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];
const BISHOP_PST = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 10, 10, 5, 0, -10,
  -10, 5, 5, 10, 10, 5, 5, -10,
  -10, 0, 10, 10, 10, 10, 0, -10,
  -10, 10, 10, 10, 10, 10, 10, -10,
  -10, 5, 0, 0, 0, 0, 5, -10,
  -20, -10, -10, -10, -10, -10, -10, -20,
];
const ROOK_PST = [
  0, 0, 0, 0, 0, 0, 0, 0,
  5, 10, 10, 10, 10, 10, 10, 5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  -5, 0, 0, 0, 0, 0, 0, -5,
  0, 0, 0, 5, 5, 0, 0, 0,
];
const QUEEN_PST = [
  -20, -10, -10, -5, -5, -10, -10, -20,
  -10, 0, 0, 0, 0, 0, 0, -10,
  -10, 0, 5, 5, 5, 5, 0, -10,
  -5, 0, 5, 5, 5, 5, 0, -5,
  0, 0, 5, 5, 5, 5, 0, -5,
  -10, 5, 5, 5, 5, 5, 0, -10,
  -10, 0, 5, 0, 0, 0, 0, -10,
  -20, -10, -10, -5, -5, -10, -10, -20,
];
const KING_PST = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
  20, 20, 0, 0, 0, 0, 20, 20,
  20, 30, 10, 0, 0, 10, 30, 20,
];
const KING_PST_EG = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10, 0, 0, -10, -20, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 30, 40, 40, 30, -10, -30,
  -30, -10, 20, 30, 30, 20, -10, -30,
  -30, -30, 0, 0, 0, 0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

const PST_MG = [null, PAWN_PST, KNIGHT_PST, BISHOP_PST, ROOK_PST, QUEEN_PST, KING_PST];
const PST_EG = [null, PAWN_PST_EG, KNIGHT_PST, BISHOP_PST, ROOK_PST, QUEEN_PST, KING_PST_EG];

const pawnFiles = [new Int8Array(8), new Int8Array(8)];
const pawnRanks = [new Int32Array(8), new Int32Array(8)];
const SQUARE_TO_INDEX = new Int8Array(2 * 128);
for (let rank = 0; rank < 8; rank += 1) {
  for (let file = 0; file < 8; file += 1) {
    SQUARE_TO_INDEX[WHITE * 128 + rank * 16 + file] = (7 - rank) * 8 + file;
    SQUARE_TO_INDEX[BLACK * 128 + rank * 16 + file] = rank * 8 + file;
  }
}

function evaluate(pos) {
  const board = pos.board;
  for (let file = 0; file < 8; file += 1) {
    pawnFiles[WHITE][file] = 0;
    pawnFiles[BLACK][file] = 0;
    pawnRanks[WHITE][file] = 0;
    pawnRanks[BLACK][file] = 0;
  }
  let mg = 0;
  let eg = 0;
  let phase = 0;
  let whiteBishops = 0;
  let blackBishops = 0;

  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const square = rank * 16 + file;
      const piece = board[square];
      if (!piece) continue;
      const type = piece & 7;
      if (type === KING) continue;
      const color = piece >> 3;
      const index = SQUARE_TO_INDEX[color * 128 + square];
      const sign = color === WHITE ? 1 : -1;
      mg += sign * (PIECE_VALUE[type] + PST_MG[type][index]);
      eg += sign * (PIECE_VALUE[type] + PST_EG[type][index]);
      if (type === PAWN) {
        pawnFiles[color][file] += 1;
        pawnRanks[color][file] |= 1 << rank;
      } else if (type === BISHOP) {
        if (color === WHITE) whiteBishops += 1;
        else blackBishops += 1;
        phase += 4;
      } else if (type === KNIGHT) {
        phase += 4;
      } else if (type === ROOK) {
        phase += 2;
      } else {
        phase += 1;
      }
    }
  }

  if (whiteBishops >= 2) {
    mg += 32;
    eg += 44;
  }
  if (blackBishops >= 2) {
    mg -= 32;
    eg -= 44;
  }

  for (let color = 0; color < 2; color += 1) {
    const sign = color === WHITE ? 1 : -1;
    const own = pawnFiles[color];
    const ownRanks = pawnRanks[color];
    const enemyRanks = pawnRanks[color ^ 1];
    for (let file = 0; file < 8; file += 1) {
      const count = own[file];
      if (!count) continue;
      if (count > 1) {
        mg -= sign * 14 * (count - 1);
        eg -= sign * 22 * (count - 1);
      }
      if (!(file > 0 && own[file - 1]) && !(file < 7 && own[file + 1])) {
        mg -= sign * 16;
        eg -= sign * 12;
      }
      const ranks = ownRanks[file];
      if (!ranks) continue;
      const adjacent = (file > 0 ? enemyRanks[file - 1] : 0) | enemyRanks[file] | (file < 7 ? enemyRanks[file + 1] : 0);
      for (let rank = 0; rank < 8; rank += 1) {
        if (!(ranks & (1 << rank))) continue;
        const blocked = color === WHITE ? adjacent >>> (rank + 1) : adjacent & ((1 << rank) - 1);
        if (blocked) continue;
        const step = color === WHITE ? rank : 7 - rank;
        mg += sign * PASSED_MG[step];
        eg += sign * PASSED_EG[step];
      }
    }
  }

  const whiteKing = pos.kings[WHITE];
  const blackKing = pos.kings[BLACK];
  const whiteKingIndex = (7 - (whiteKing >> 4)) * 8 + (whiteKing & 7);
  const blackKingIndex = (blackKing >> 4) * 8 + (blackKing & 7);
  mg += KING_PST[whiteKingIndex] - KING_PST[blackKingIndex];
  eg += KING_PST_EG[whiteKingIndex] - KING_PST_EG[blackKingIndex];

  for (let color = 0; color < 2; color += 1) {
    const king = pos.kings[color];
    const file = king & 7;
    const rank = king >> 4;
    const ranks = pawnRanks[color];
    const low = Math.max(0, file - 1);
    const high = Math.min(7, file + 1);
    let shield = 0;
    for (let f = low; f <= high; f += 1) {
      const mask = color === WHITE ? (1 << (rank + 1)) | (1 << (rank + 2)) : (1 << (rank - 1)) | (1 << (rank - 2));
      if (ranks[f] & mask) shield += 1;
    }
    mg += (color === WHITE ? 1 : -1) * (shield * 9 - 26);
  }

  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = board[rank * 16 + file];
      if (!piece || (piece & 7) !== ROOK) continue;
      const color = piece >> 3;
      if (pawnFiles[color][file]) continue;
      const bonus = pawnFiles[color ^ 1][file] ? 11 : 22;
      mg += (color === WHITE ? 1 : -1) * bonus;
      eg += (color === WHITE ? 1 : -1) * Math.round(bonus * 0.6);
    }
  }

  const weight = Math.min(1, phase / 24);
  const score = mg * weight + eg * (1 - weight) + 10;
  return pos.side === WHITE ? Math.round(score) : -Math.round(score);
}

const TT_BITS = 18;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttLo = new Int32Array(TT_SIZE);
const ttHi = new Int32Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttMove = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Int8Array(TT_SIZE);

const FLAG_EXACT = 0;
const FLAG_LOWER = 1;
const FLAG_UPPER = 2;
const MAX_PLY = 64;

class Searcher {
  constructor(position) {
    this.pos = position;
    this.nodes = 0;
    this.deadline = Infinity;
    this.killers = new Int32Array(MAX_PLY * 2);
    this.history = new Int32Array(16 * 128);
    this.moveStack = [];
  }

  pool(ply) {
    if (!this.moveStack[ply]) this.moveStack[ply] = [];
    return this.moveStack[ply];
  }

  checkTime() {
    this.nodes += 1;
    if ((this.nodes & 1023) === 0 && now() >= this.deadline) throw TIMEOUT;
  }

  probe(depth, alpha, beta, ply) {
    const index = (this.pos.hashLo ^ (this.pos.hashHi >>> 13)) & TT_MASK;
    if (ttLo[index] !== this.pos.hashLo || ttHi[index] !== this.pos.hashHi) return null;
    const move = ttMove[index];
    if (ttDepth[index] < depth) return { move, score: null };
    let score = ttScore[index];
    if (score > MATE - 512) score -= ply;
    else if (score < -MATE + 512) score += ply;
    const flag = ttFlag[index];
    if (flag === FLAG_EXACT) return { move, score };
    if (flag === FLAG_LOWER && score >= beta) return { move, score };
    if (flag === FLAG_UPPER && score <= alpha) return { move, score };
    return { move, score: null };
  }

  store(depth, score, flag, move, ply) {
    const index = (this.pos.hashLo ^ (this.pos.hashHi >>> 13)) & TT_MASK;
    if (ttLo[index] === this.pos.hashLo && ttHi[index] === this.pos.hashHi && ttDepth[index] > depth) return;
    let stored = score;
    if (stored > MATE - 512) stored += ply;
    else if (stored < -MATE + 512) stored -= ply;
    ttLo[index] = this.pos.hashLo;
    ttHi[index] = this.pos.hashHi;
    ttScore[index] = stored;
    ttMove[index] = move;
    ttDepth[index] = depth;
    ttFlag[index] = flag;
  }

  moveScore(move, hashMove, killer0, killer1) {
    if (move === hashMove) return 1000000;
    const board = this.pos.board;
    const to = moveTo(move);
    const victim = board[to];
    const promotion = movePromotion(move);
    if (victim || moveFlags(move) & MOVE_EN_PASSANT) {
      const victimType = victim ? victim & 7 : PAWN;
      return 100000 + PIECE_VALUE[victimType] * 8 - (board[moveFrom(move)] & 7);
    }
    if (promotion) return 90000 + PIECE_VALUE[promotion];
    if (move === killer0) return 80000;
    if (move === killer1) return 79000;
    return this.history[(board[moveFrom(move)] || 0) * 128 + to];
  }

  orderMoves(moves, hashMove, ply) {
    const killer0 = this.killers[ply * 2];
    const killer1 = this.killers[ply * 2 + 1];
    moves.sort((a, b) => this.moveScore(b, hashMove, killer0, killer1) - this.moveScore(a, hashMove, killer0, killer1));
  }

  search(depth, alpha, beta, ply) {
    this.checkTime();
    const pos = this.pos;
    if (ply > 0 && (pos.half >= 100 || pos.isRepetition())) return 0;
    const inCheck = pos.inCheck();
    if (depth <= 0) return this.quiesce(alpha, beta, ply);

    const hashed = this.probe(depth, alpha, beta, ply);
    if (hashed && hashed.score !== null) return hashed.score;
    const hashMove = hashed ? hashed.move : 0;

    const canNull = !inCheck
      && depth >= 3
      && Math.abs(beta) < MATE - 512
      && (pos.has(KNIGHT) || pos.has(BISHOP) || pos.has(ROOK) || pos.has(QUEEN));
    if (canNull) {
      pos.makeNull();
      let score;
      try {
        score = -this.search(depth - 3, -beta, -beta + 1, ply + 1);
      } finally {
        pos.unmake();
      }
      if (score >= beta && Math.abs(score) < MATE - 512) return score;
    }

    const moves = generateMoves(pos, this.pool(ply));
    this.orderMoves(moves, hashMove, ply);
    let best = -INFINITY;
    let bestMove = 0;
    let legal = 0;
    const startAlpha = alpha;
    for (let i = 0; i < moves.length; i += 1) {
      const move = moves[i];
      const quiet = moveIsQuiet(pos, move);
      pos.make(move);
      if (isAttacked(pos, pos.kings[pos.side ^ 1], pos.side)) {
        pos.unmake();
        continue;
      }
      legal += 1;
      let score;
      if (legal === 1) {
        score = -this.search(depth - 1, -beta, -alpha, ply + 1);
      } else {
        score = -this.search(depth - 1, -alpha - 1, -alpha, ply + 1);
        if (score > alpha && score < beta) score = -this.search(depth - 1, -beta, -alpha, ply + 1);
      }
      pos.unmake();
      if (score > best) {
        best = score;
        bestMove = move;
      }
      if (score > alpha) {
        alpha = score;
        if (score >= beta) {
          if (quiet) {
            this.killers[ply * 2 + 1] = this.killers[ply * 2];
            this.killers[ply * 2] = move;
            this.history[(pos.board[moveFrom(move)] || 0) * 128 + moveTo(move)] += depth * depth;
          }
          this.store(depth, score, FLAG_LOWER, move, ply);
          return score;
        }
      }
    }
    if (!legal) return inCheck ? -MATE + ply : 0;
    this.store(depth, best, best > startAlpha ? FLAG_EXACT : FLAG_UPPER, bestMove, ply);
    return best;
  }

  quiesce(alpha, beta, ply) {
    this.checkTime();
    const pos = this.pos;
    if (ply > 0 && (pos.half >= 100 || pos.isRepetition())) return 0;
    const inCheck = pos.inCheck();
    let best = -INFINITY;
    if (!inCheck) {
      const stand = evaluate(pos);
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
      if (ply > 48) return best;
    }
    const moves = generateMoves(pos, this.pool(MAX_PLY + ply), !inCheck);
    this.orderMoves(moves, 0, ply);
    let legal = 0;
    for (let i = 0; i < moves.length; i += 1) {
      const move = moves[i];
      pos.make(move);
      if (isAttacked(pos, pos.kings[pos.side ^ 1], pos.side)) {
        pos.unmake();
        continue;
      }
      legal += 1;
      const score = -this.quiesce(-beta, -alpha, ply + 1);
      pos.unmake();
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    if (inCheck && !legal) return -MATE + ply;
    return best;
  }

  searchRoot(depth, previous) {
    const pos = this.pos;
    const moves = generateMoves(pos, this.pool(0));
    if (previous && previous.length) {
      const scores = new Map();
      for (const entry of previous) scores.set(entry.move, entry.score);
      const fallback = -INFINITY;
      moves.sort((a, b) => (scores.has(b) ? scores.get(b) : fallback) - (scores.has(a) ? scores.get(a) : fallback));
    } else {
      this.orderMoves(moves, 0, 0);
    }
    let alpha = -INFINITY;
    let bestMove = 0;
    let bestScore = -INFINITY;
    const scored = [];
    for (let i = 0; i < moves.length; i += 1) {
      const move = moves[i];
      pos.make(move);
      if (isAttacked(pos, pos.kings[pos.side ^ 1], pos.side)) {
        pos.unmake();
        continue;
      }
      let score;
      try {
        score = -this.search(depth - 1, -INFINITY, -alpha, 1);
      } finally {
        pos.unmake();
      }
      scored.push({ move, score });
      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
      if (score > alpha) alpha = score;
    }
    if (!bestMove) return null;
    return { move: bestMove, score: bestScore, scored };
  }
}

const IN_WORKER = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

const OPENING_BOOK = [
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
  ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'],
  ['e4', 'e5', 'Nf3', 'Nf6'],
  ['e4', 'c5', 'Nf3', 'd6'],
  ['e4', 'e6', 'd4'],
  ['e4', 'c6', 'd4'],
  ['d4', 'd5', 'c4'],
  ['d4', 'Nf6', 'c4', 'e6'],
  ['Nf3', 'd5', 'd4'],
  ['c4', 'e5', 'Nc3'],
];

const bookCache = new Map();
const positionKey = (fen) => fen.split(' ').slice(0, 4).join(' ');
for (const line of OPENING_BOOK) {
  const chess = new Chess();
  for (const san of line) {
    const key = positionKey(chess.fen());
    const options = bookCache.get(key) || [];
    if (!options.includes(san)) options.push(san);
    bookCache.set(key, options);
    chess.move(san);
  }
}

function bookMove(fen) {
  const options = bookCache.get(positionKey(fen));
  if (!options || !options.length) return null;
  try {
    const chess = new Chess(fen);
    const made = chess.move(options[Math.floor(Math.random() * options.length)]);
    if (!made) return null;
    return { from: made.from, to: made.to, promotion: made.promotion || '', san: made.san };
  } catch {
    return null;
  }
}

const LEVELS = {
  easy: { maxDepth: 2, timeMs: 260, tolerance: 130, width: 4, blunder: 0.3 },
  medium: { maxDepth: 7, timeMs: 700, tolerance: 30, width: 3, blunder: 0.05 },
  master: { maxDepth: 64, timeMs: 1800, tolerance: 0, width: 1, blunder: 0 },
};

function searchBest(fen, config) {
  const position = new Position(fen);
  if (!hasLegalMove(position)) return { position, result: null };
  const searcher = new Searcher(position);
  const budget = IN_WORKER ? config.timeMs : Math.min(config.timeMs, 650);
  searcher.deadline = now() + budget;
  let result = null;
  let previous = null;
  for (let depth = 1; depth <= config.maxDepth; depth += 1) {
    let iteration = null;
    try {
      iteration = searcher.searchRoot(depth, previous);
    } catch (err) {
      if (err !== TIMEOUT) throw err;
      break;
    }
    if (!iteration) break;
    result = iteration;
    previous = iteration.scored;
    if (Math.abs(iteration.score) > MATE - 512) break;
    if (now() >= searcher.deadline) break;
  }
  return { position, result };
}

function describe(fen, move) {
  if (!move) return null;
  const from = nameOf(moveFrom(move));
  const to = nameOf(moveTo(move));
  const promotion = PROMOTION_LETTERS[movePromotion(move)] || '';
  try {
    const chess = new Chess(fen);
    const made = chess.move({ from, to, ...(promotion ? { promotion } : {}) });
    if (!made) return null;
    return { from: made.from, to: made.to, promotion, san: made.san };
  } catch {
    return null;
  }
}

function randomLegalMove(fen) {
  try {
    const chess = new Chess(fen);
    const moves = chess.moves({ verbose: true });
    if (!moves.length) return null;
    const move = moves[Math.floor(Math.random() * moves.length)];
    return { from: move.from, to: move.to, promotion: move.promotion || '', san: move.san };
  } catch {
    return null;
  }
}

function pickMove(result, config) {
  const scored = [...result.scored].sort((a, b) => b.score - a.score);
  if (!scored.length) return result.move;
  const top = scored[0].score;
  const pool = scored.filter((entry) => entry.score >= top - config.tolerance).slice(0, config.width);
  if (!pool.length) return result.move;
  const index = config.blunder && pool.length > 1 && Math.random() < config.blunder
    ? 1 + Math.floor(Math.random() * (pool.length - 1))
    : Math.floor(Math.random() * pool.length);
  return pool[Math.min(index, pool.length - 1)].move;
}

export function chooseBotMove(fen, level = 'medium') {
  const config = LEVELS[level] || LEVELS.medium;
  if (level !== 'easy' && Math.random() < 0.9) {
    const opening = bookMove(fen);
    if (opening) return opening;
  }
  try {
    const { result } = searchBest(fen, config);
    if (result) {
      const described = describe(fen, pickMove(result, config));
      if (described) return described;
    }
  } catch {
    /* fall back to a random legal move below */
  }
  return randomLegalMove(fen);
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
