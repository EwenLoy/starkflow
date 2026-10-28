import { ChessScene } from './scene.js?v=20261028-23';
import { StarkFlowClient } from './net.js?v=20261028-14';
import { ChessSession, START_FEN } from './session.js?v=20261028-14';
import { ChessAudio } from './audio.js?v=20261028-14';
import { chooseBotMove, findHint, openingName } from './engine.js?v=20261028-14';
import { pieceGlyph } from './pieces.js?v=20261028-22';
import { LocalNet } from './offline.js?v=20261028-14';
import {
  applyTranslations,
  getLocale,
  isRussian,
  pluralRu,
  setLocale,
  t,
} from './i18n.js?v=20261028-14';

import { WS_URL } from './env.js?v=20261028-16';

const CONFIG = {
  // The working node is never in the repository: `env.js` is rewritten during
  // the Pages build from the STARKFLOW_WS_URL variable, while the footer, the
  // help text and the README keep naming the public endpoint.
  url: WS_URL,
  app: 'starkflow-chess',
  lobby: 'salon',
};

/** How long the side that is still at the table promises to wait before asking again. */
const SUSPEND_HOLD_MS = 30000;
/** The room keeps a lost seat this long; the server caps the request at 5 minutes. */
const SUSPEND_SEAT_MS = 300000;
const RESUME_KEY = 'ornate-chess:resume';
const RESUME_TTL_MS = 30 * 60 * 1000;

const EN_ADJECTIVES = ['Emerald', 'Midnight', 'Golden', 'Quiet', 'Royal', 'Azure', 'Copper', 'Northern', 'Amethyst', 'Silver'];
const EN_NOUNS = ['Gambit', 'Salon', 'Study', 'Queen', 'Manoeuvre', 'Endgame', 'Opening', 'Caprice', 'Vernissage', 'Tournament'];
const RU_ADJECTIVES = ['Изумрудный', 'Полночный', 'Золотой', 'Тихий', 'Королевский', 'Лазурный', 'Медный', 'Северный', 'Аметистовый', 'Серебряный'];
const RU_NOUNS = ['гамбит', 'салон', 'этюд', 'ферзь', 'манёвр', 'эндшпиль', 'дебют', 'каприс', 'вернисаж', 'турнир'];

const $ = (id) => document.getElementById(id);
const PIECE_ORDER = ['q', 'r', 'b', 'n', 'p'];

function randomRoomName() {
  const ru = isRussian();
  const adjectives = ru ? RU_ADJECTIVES : EN_ADJECTIVES;
  const nouns = ru ? RU_NOUNS : EN_NOUNS;
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
}

function randomGuestName() {
  return t('Guest-{n}', { n: Math.floor(100 + Math.random() * 900) });
}

function loadStored(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 20) || randomGuestName();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function roomUrl(roomId) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  if (roomId) url.searchParams.set('room', roomId);
  return url.toString();
}

function loadResumeHint() {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const hint = JSON.parse(raw);
    if (!hint || typeof hint.room !== 'string' || !hint.room) return null;
    if (Date.now() - (Number(hint.savedAt) || 0) > RESUME_TTL_MS) return null;
    return hint;
  } catch {
    return null;
  }
}

function saveResumeHint(hint) {
  try {
    if (hint) sessionStorage.setItem(RESUME_KEY, JSON.stringify(hint));
    else sessionStorage.removeItem(RESUME_KEY);
  } catch {
    /* private mode */
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

class SalonApp {
  constructor() {
    applyTranslations();
    document.title = t('Ornate · 3D Chess Salon');
    const description = document.querySelector('meta[name="description"]');
    if (description) {
      description.setAttribute('content', t('Ornate Chess Salon — cinematic 3D online chess with a room list. StarkFlow WebSocket, Three.js.'));
    }

    this.name = cleanName(loadStored('ornate-chess:name', randomGuestName()));
    store('ornate-chess:name', this.name);
    this.nameInput = $('nameInput');
    this.roomInput = $('roomNameInput');
    this.nameInput.value = this.name;
    this.roomInput.value = randomRoomName();
    this.roomAuto = true;
    this.updateSeal();
    this.updateLangButton();

    this.audio = new ChessAudio();
    this.net = new StarkFlowClient({ ...CONFIG, name: this.name });
    this.onlineSession = new ChessSession(this.net);
    this.session = this.onlineSession;
    this.scene = new ChessScene($('scene'));
    this.scene.setPosition(START_FEN, { initial: true });
    this.scene.setMode('lobby');

    this.directRoom = new URLSearchParams(location.search).get('room') || '';
    this.triedDirect = false;
    this.resumeHint = loadResumeHint();
    this.resumeTried = false;
    this.resumeRetried = false;
    this.suspendedSeat = 0;
    this.holdUntil = 0;
    this.presenceWasMine = false;
    if (this.resumeHint && (!this.directRoom || this.directRoom === this.resumeHint.room)) {
      // Back in the same tab after a reload: ask first instead of walking in silently.
      this.directRoom = '';
    } else if (this.resumeHint) {
      // An invitation to another table wins over the old unfinished game.
      saveResumeHint(null);
      this.resumeHint = null;
    }
    this.hasRenderedBoard = false;
    this.lastFen = '';
    this.lastViewColor = null;
    this.selected = null;
    this.legal = [];
    this.promotion = null;
    this.roomList = [];
    this.pendingCreate = null;
    this.pendingCreateTries = 0;
    this.joining = false;
    this.turnTimer = null;
    this.clockTimer = null;
    this.offlineNotified = false;
    this.resultKey = '';
    this.suppressTurnToast = true;
    this.modalOpen = false;
    this.lastFocus = null;
    this.hintBusy = false;
    this.latency = null;
    this.lastNetStatus = { state: 'connecting' };
    this.offline = false;
    this.offlineLevel = 'medium';
    this.offlineColor = 'w';
    this.botColor = 'b';
    this.botName = 'Bot';
    this.botThinking = false;
    this.botRequestId = 0;
    this.botTimer = null;
    this.botWatchdog = null;
    this.botWorker = null;
    this.botWorkerBroken = false;
    this.offlineNet = null;
    this.offlineSession = null;
    this.botSetupLevel = 'medium';
    this.botSetupColor = 'w';

    this.bindUi();
    this.bindNet();
    this.bindSession(this.session);
    this.start();
  }

  get gnet() {
    return this.offline ? this.offlineNet : this.net;
  }

  /* ------------------------------------------------------------- startup */
  start() {
    this.refreshSoundButton();
    this.renderRooms();
    this.bumpBoot(18, t('Lighting the candles…'));
    setTimeout(() => this.bumpBoot(38, t('Setting the pieces…')), 260);
    setTimeout(() => this.bumpBoot(58, t('Opening the salon doors…')), 520);
    setTimeout(() => this.bumpBoot(78, t('Looking for guests at the tables…')), 800);

    this.clockTimer = setInterval(() => this.updateClock(), 1000);
    this.listTimer = setInterval(() => {
      if (!this.offline && !this.net.room && document.visibilityState === 'visible' && this.net.connected) {
        this.net.listRooms();
      }
    }, 6000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.offline && !this.net.room && this.net.connected) this.net.listRooms();
    });

    this.net.connect(this.name).catch(() => {
      this.showToast(t('Server did not respond. Try again.'), 'error');
    });

    setTimeout(() => this.finishBoot(), 1550);
  }

  bumpBoot(percent, label) {
    const bar = $('bootBar');
    if (bar) bar.style.width = `${percent}%`;
    const text = $('bootLabel');
    if (text && label) text.textContent = label;
  }

  finishBoot() {
    if (this.booted) return;
    this.booted = true;
    this.bumpBoot(100, t('Welcome'));
    const boot = $('boot');
    const app = $('app');
    app.classList.add('is-ready');
    app.setAttribute('aria-hidden', 'false');
    setTimeout(() => boot.classList.add('is-done'), 450);
    if (this.resumeHint) setTimeout(() => this.offerResume(), 420);
  }

  /* --------------------------------------------------------------- net UI */
  bindNet() {
    this.net.on('status', (status) => this.updateStatus(status));
    this.net.on('welcome', () => {
      this.name = this.net.welcomeInfo.name || this.name;
      this.nameInput.value = this.name;
      this.updateSeal();
      this.renderRooms();
      if (this.directRoom && !this.triedDirect && !this.offline) {
        this.triedDirect = true;
        this.net.joinRoom(this.directRoom);
      }
    });
    this.net.on('rooms', (rooms) => {
      this.roomList = rooms;
      this.renderRooms();
    });
    this.net.on('latency', (ms) => {
      this.latency = ms;
      $('pingText').textContent = `${ms} ${isRussian() ? 'мс' : 'ms'}`;
      $('latencyStat').textContent = `${ms} ${isRussian() ? 'мс' : 'ms'}`;
    });
    this.net.on('room.joined', (detail) => {
      this.joining = false;
      this.pendingCreate = null;
      this.pendingCreateTries = 0;
      $('createBtn').disabled = false;
      if (this.offline) {
        this.net.leaveRoom();
        return;
      }
      this.enterGame(detail);
    });
    this.net.on('room.left', () => {
      if (this.offline) return;
      this.enterLobby();
    });
    this.net.on('room.missing', () => {
      if (this.offline) return;
      const hint = loadResumeHint();
      if (hint?.room && this.resumeTried && !this.resumeRetried) {
        // A rejoin right after a drop can race the room registry. Try once more
        // before telling the player that the whole game is gone.
        this.resumeRetried = true;
        setTimeout(() => {
          if (!this.net.room && this.net.connected) this.net.joinRoom(hint.room);
        }, 1500);
        return;
      }
      saveResumeHint(null);
      this.clearRoomQuery();
      this.enterLobby();
      this.showToast(t('That table has already closed — the game is gone.'), 'error');
    });
    this.net.on('room.full', () => {
      this.joining = false;
      this.showToast(t('There are no seats left at this table.'), 'error');
    });
    this.net.on('players.changed', (change) => {
      const backFromAway = !!change.resumed && change.resumed !== this.net.you && this.suspendedSeat === change.resumed;
      this.renderGame();
      if (change.joined && change.joined !== this.net.you) {
        const p = this.net.players.get(change.joined);
        this.showToast(t('{name} joined the table.', { name: p?.name || t('Guest') }), 'ok');
      }
      if (change.left) {
        const p = change.player;
        if (p && p.id !== this.net.you && change.reason !== 'timeout') this.showToast(t('{name} left the table.', { name: p.name || t('Guest') }));
      }
      if (change.suspended && change.suspended !== this.net.you && !this.session.isPlaying) {
        // A game in progress explains the wait itself, on the presence bar.
        this.showToast(t('Opponent lost connection — the seat is held for 30 seconds.'));
      }
      if (backFromAway) this.showToast(t('Opponent is back at the table.'), 'ok');
    });
    this.net.on('host.changed', () => {
      this.renderGame();
    });
    this.net.on('duplicate-hint', () => {
      this.showToast(t('This table is already open in another tab — close the extra one.'), 'error');
    });
    this.net.on('error', (err) => this.onNetError(err));
    this.net.on('game.event', (event) => {
      if (event.code === 90 && event.data?.text) {
        this.showToast(`${this.playerName(event.from)}: ${String(event.data.text).slice(0, 80)}`);
      }
    });
  }

  bindSession(session) {
    const current = () => this.session === session;
    session.on('change', (snapshot) => {
      if (!current()) return;
      this.syncBoardFromSnapshot(snapshot);
      this.renderGame();
      this.maybeBotMove();
    });
    session.on('move', (data) => {
      if (!current()) return;
      if (data.fen === this.lastFen) {
        this.updateBoardMarkers();
        this.maybeBotMove();
        return;
      }
      this.scene.setPosition(data.fen, { animate: true, lastMove: data.move });
      this.lastFen = data.fen;
      this.hasRenderedBoard = true;
      this.updateBoardMarkers();
      if (data.move.captured) this.audio.capture();
      else if (data.move.promotion) this.audio.capture();
      else this.audio.move();
      if (data.inCheck) setTimeout(() => this.audio.check(), 130);
      this.renderGame();
      this.maybeBotMove();
    });
    session.on('turn', (turn) => {
      if (!current()) return;
      if (this.offline && turn.color === this.botColor) {
        this.showTurnToast(t('{name} is thinking', { name: this.botName }));
      } else if (turn.inCheck) {
        this.showTurnToast(turn.mine ? t('Check! Your move') : t('Check on the opponent'));
      } else if (turn.mine) {
        this.showTurnToast(t('Your turn'));
      } else {
        this.showTurnToast(t(turn.color === 'w' ? 'White to move' : 'Black to move'));
      }
      if (!this.suppressTurnToast) this.audio.turn();
      this.suppressTurnToast = false;
      this.maybeBotMove();
    });
    session.on('pending', () => {
      if (!current()) return;
      this.syncInteraction();
      if (!this.offline) this.showTurnToast(t('Move sent…'));
    });
    session.on('result', (snapshot) => {
      if (!current()) return;
      this.onResult(snapshot);
    });
    session.on('toast', ({ text, type }) => {
      if (current()) this.showToast(text, type);
    });
    session.on('invalid-state', () => {
      if (current()) this.showToast(t('The table state arrived corrupted. Waiting for an update.'), 'error');
    });
  }

  bindUi() {
    $('createBtn').addEventListener('click', () => this.createRoom());
    $('quickBtn').addEventListener('click', () => this.quickGame());
    $('botBtn').addEventListener('click', () => this.openBotSetup());
    $('refreshBtn').addEventListener('click', () => this.refreshRooms());
    $('langBtn').addEventListener('click', () => this.switchLanguage());
    $('nameInput').addEventListener('change', () => this.applyName());
    $('nameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.applyName();
      }
    });
    this.nameInput.addEventListener('input', () => this.updateSeal());
    this.roomInput.addEventListener('input', () => {
      this.roomAuto = false;
    });
    this.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.createRoom();
      }
    });
    $('soundBtn').addEventListener('click', () => {
      const on = this.audio.toggle();
      this.refreshSoundButton();
      this.showToast(t(on ? 'Sound on' : 'Sound off'));
    });
    $('helpBtn').addEventListener('click', () => this.openHelp());
    $('howBtn').addEventListener('click', () => this.openHelp());
    $('fullscreenBtn').addEventListener('click', () => this.toggleFullscreen());
    $('netPill').addEventListener('click', () => {
      if (!this.net.connected) this.net.manualRetry();
    });
    $('leaveBtn').addEventListener('click', () => this.confirmLeave());
    $('brandBtn').addEventListener('click', () => {
      if (this.gnet.room) this.confirmLeave();
    });
    $('copyBtn').addEventListener('click', () => this.copyInvite());
    $('inviteBtn').addEventListener('click', () => this.copyInvite());
    $('topViewBtn').addEventListener('click', () => this.scene.topView());
    $('flipBtn').addEventListener('click', () => this.scene.flipView());
    $('hintBtn').addEventListener('click', () => this.giveHint());
    $('drawBtn').addEventListener('click', () => this.askDraw());
    $('resignBtn').addEventListener('click', () => this.confirmResign());
    $('acceptDrawBtn').addEventListener('click', () => {
      this.session.acceptDraw();
      this.showToast(t('Draw accepted.'), 'ok');
    });
    $('declineDrawBtn').addEventListener('click', () => {
      this.session.declineDraw();
      this.showToast(t('Draw declined.'));
    });
    $('presenceWaitBtn').addEventListener('click', () => this.extendHold());
    $('presenceEndBtn').addEventListener('click', () => this.endAbandonedGame());
    $('rematchBtn').addEventListener('click', () => this.rematch());
    $('resultRematchBtn').addEventListener('click', () => this.rematch());
    $('resultLobbyBtn').addEventListener('click', () => this.confirmLeave());
    $('modalRoot').addEventListener('click', (e) => {
      if (e.target === $('modalRoot') || e.target.classList.contains('modal-backdrop')) this.closeModal();
    });
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('pointerdown', (e) => {
      this.globalDown = { x: e.clientX, y: e.clientY };
    }, true);
    window.addEventListener('pointerup', (e) => this.onGlobalPointerUp(e), true);
    window.addEventListener('online', () => {
      if (!this.net.connected) this.net.manualRetry();
    });
  }

  /* --------------------------------------------------------- connection */
  updateStatus(status) {
    this.lastNetStatus = status;
    const pill = $('netPill');
    const text = $('netText');
    pill.classList.remove('is-online', 'is-connecting', 'is-offline');
    if (status.state === 'online') {
      pill.classList.add('is-online');
      text.textContent = t('Online');
      this.offlineNotified = false;
    } else if (status.state === 'retrying') {
      pill.classList.add('is-connecting');
      text.textContent = t('Reconnecting {n}', { n: status.retry });
    } else if (status.state === 'exhausted') {
      pill.classList.add('is-offline');
      text.textContent = t('No connection');
      this.showToast(t('Could not reconnect. Tap the network indicator.'), 'error');
    } else if (status.state === 'offline' || status.state === 'error') {
      pill.classList.add('is-offline');
      text.textContent = t('No connection');
      if (!this.offlineNotified) {
        this.offlineNotified = true;
        if (this.net.room) this.showToast(t('Connection lost. Rejoining the table automatically…'));
      }
    } else if (status.state === 'reauth') {
      pill.classList.add('is-connecting');
      text.textContent = t('Refreshing session');
    } else {
      pill.classList.add('is-connecting');
      text.textContent = t(status.state === 'hello' ? 'Signing in…' : 'Connecting…');
    }
    $('pingText').textContent = this.net.latency != null ? `${this.net.latency} ${isRussian() ? 'мс' : 'ms'}` : '';
    this.syncInteraction();
    if (status.state === 'online') {
      if (this.presenceWasMine) {
        this.presenceWasMine = false;
        if (this.gnet.room) this.showToast(t('Back at your table'), 'ok');
      }
      this.renderRooms();
    }
    this.renderPresence();
  }

  onNetError({ code, msg }) {
    const messages = {
      100: 'Incompatible protocol version.',
      101: 'The server did not understand the message.',
      102: 'Sign in first.',
      200: 'The session expired — signing in again.',
      300: 'Table not found.',
      301: 'No seats left at the table.',
      302: 'This table is closed.',
      303: 'You are already at a table.',
      305: 'You are not at a table.',
      306: 'The table name is too short or invalid.',
      307: 'Wrong table password.',
      308: 'A table with that name already exists.',
      400: 'Unknown state key.',
      401: 'Type conflict in the table state.',
      500: 'Too many messages. Try again.',
      501: 'The message is too large.',
      502: 'The server is busy.',
    };
    if (code === 308 && this.pendingCreate && this.pendingCreateTries < 2) {
      this.pendingCreateTries += 1;
      const next = randomRoomName();
      this.roomInput.value = next;
      this.roomAuto = true;
      this.pendingCreate = next;
      this.net.createRoom(next, { maxPlayers: 8, emptyTTL: 300, suspendTTL: 300 });
      this.showToast(t('Name already taken — opening a neighbouring table.'), 'ok');
      return;
    }
    if (code === 303) return;
    this.joining = false;
    $('createBtn').disabled = false;
    this.showToast(messages[code] ? t(messages[code]) : t('Server error {code}: {msg}', { code, msg: msg || '' }).trim(), 'error');
    if (code === 500) this.showToast(t('Rate limit: wait a second.'), 'error');
  }

  /* ------------------------------------------------------------- identity */
  updateSeal() {
    const fallback = isRussian() ? 'Г' : 'G';
    const raw = this.nameInput.value.trim() || fallback;
    $('playerInitial').textContent = [...raw][0]?.toUpperCase() || fallback;
  }

  updateLangButton() {
    const next = isRussian() ? 'EN' : 'RU';
    const key = isRussian() ? 'Switch to English' : 'Switch to Russian';
    $('langLabel').textContent = next;
    $('langBtn').setAttribute('aria-label', t(key));
    $('langBtn').setAttribute('title', t(key));
  }

  switchLanguage() {
    if (this.modalOpen) this.closeModal(true);
    const next = isRussian() ? 'en' : 'ru';
    setLocale(next);
    this.updateLangButton();
    this.updateSeal();
    if (this.roomAuto) this.roomInput.value = randomRoomName();
    this.refreshSoundButton();
    if (this.offline) {
      this.botName = this.botLevelName(this.offlineLevel);
      const bot = this.offlineNet?.players.get(2);
      if (bot) bot.name = this.botName;
      $('roomTitle').textContent = this.botName;
      $('roomKicker').textContent = `${t('Offline salon')} · ${this.botName}`;
    } else if (this.net.room) {
      $('roomKicker').textContent = `${t('Table')} #${this.net.room.id}`;
    }
    this.renderRooms();
    this.renderGame();
    this.updateStatus(this.lastNetStatus || { state: 'connecting' });
    this.showToast(t(next === 'ru' ? 'Language switched to Russian' : 'Language switched to English'), 'ok');
  }

  async applyName() {
    const value = cleanName(this.nameInput.value);
    this.name = value;
    this.nameInput.value = value;
    store('ornate-chess:name', value);
    this.updateSeal();
    if (this.gnet.room) return;
    if (!this.net.connected) {
      if (this.net.active) await this.net.connect(value).catch(() => {});
      return;
    }
    if (this.net.welcomeInfo?.name === value) return;
    try {
      await this.net.rename(value);
      this.showToast(t('Name updated.'), 'ok');
    } catch {
      this.showToast(t('Could not update the name.'), 'error');
    }
  }

  async prepareIdentity() {
    const value = cleanName(this.nameInput.value);
    this.name = value;
    this.nameInput.value = value;
    store('ornate-chess:name', value);
    this.updateSeal();
    if (!this.net.connected) {
      await this.net.connect(value);
    } else if (this.net.welcomeInfo?.name !== value && !this.net.room) {
      await this.net.rename(value);
    }
  }

  /* --------------------------------------------------------------- lobby */
  tableCountLabel(n) {
    if (isRussian()) return `${n} ${pluralRu(n, 'стол', 'стола', 'столов')}`;
    return `${n} ${n === 1 ? 'table' : 'tables'}`;
  }

  playerCountLabel(n) {
    if (isRussian()) return `${n} ${pluralRu(n, 'игрок', 'игрока', 'игроков')}`;
    return `${n} ${n === 1 ? 'player' : 'players'}`;
  }

  renderRooms() {
    const list = $('roomList');
    const rooms = this.roomList;
    $('tableCount').textContent = String(rooms.length);
    const players = rooms.reduce((sum, room) => sum + (Number(room.players) || 0), 0);
    $('onlineCount').textContent = String(players);
    $('latencyStat').textContent = this.latency != null ? `${this.latency} ${isRussian() ? 'мс' : 'ms'}` : '—';

    list.innerHTML = '';
    if (!rooms.length) {
      const empty = document.createElement('div');
      empty.className = 'room-empty';
      empty.innerHTML = `
        <span class="room-empty__sigil">♞</span>
        <strong>${t('No tables yet')}</strong>
        <span>${t('Open the first table — it will appear here. You can send the link to a friend right away.')}</span>
      `;
      list.appendChild(empty);
      return;
    }

    const label = document.createElement('div');
    label.className = 'room-list__label';
    label.innerHTML = `<span>${this.tableCountLabel(rooms.length)}</span><span>${t('tap to join')}</span>`;
    list.appendChild(label);

    for (const room of rooms) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'room-card';
      const count = Number(room.players) || 0;
      const max = Number(room.maxPlayers) || 8;
      const full = count >= max;
      const badgeClass = full ? 'room-card__badge room-card__badge--full' : count === 1 ? 'room-card__badge room-card__badge--live' : 'room-card__badge';
      const badgeText = full ? t('full') : count === 1 ? t('waiting for guest') : this.playerCountLabel(count);
      card.innerHTML = `
        <span class="room-card__sigil">${count === 1 ? '♛' : count >= 3 ? '♜' : '♞'}</span>
        <span class="room-card__text">
          <strong class="room-card__name">${escapeHtml(room.room || t('No name'))}</strong>
          <span class="room-card__meta"><span>#${escapeHtml(String(room.id || '').slice(0, 6))}</span><i></i><span>${count} / ${max}</span>${room.locked ? `<i></i><span>${t('locked')}</span>` : ''}</span>
        </span>
        <span class="${badgeClass}">${badgeText}</span>
      `;
      card.addEventListener('click', () => this.joinRoom(room.id || room.room));
      card.disabled = full || this.joining;
      list.appendChild(card);
    }
  }

  refreshRooms() {
    if (!this.net.connected) {
      this.net.manualRetry();
      return;
    }
    const btn = $('refreshBtn');
    btn.classList.add('is-spinning');
    this.net.listRooms();
    setTimeout(() => btn.classList.remove('is-spinning'), 650);
  }

  async createRoom(customName = '') {
    if (this.joining) return;
    const room = (customName || this.roomInput.value || randomRoomName()).trim().slice(0, 32) || randomRoomName();
    if (room.length < 2) {
      this.showToast(t('Give the table a longer name.'), 'error');
      return;
    }
    this.joining = true;
    $('createBtn').disabled = true;
    $('quickBtn').disabled = true;
    this.roomInput.value = room;
    this.pendingCreate = room;
    this.pendingCreateTries = 0;
    try {
      await this.prepareIdentity();
      this.net.createRoom(room, { maxPlayers: 8, emptyTTL: 300, suspendTTL: 300 });
    } catch {
      this.joining = false;
      this.pendingCreate = null;
      $('createBtn').disabled = false;
      $('quickBtn').disabled = false;
      this.showToast(t('Could not reach the server.'), 'error');
    }
  }

  async quickGame() {
    if (this.joining) return;
    const free = this.roomList
      .filter((r) => (Number(r.players) || 0) < (Number(r.maxPlayers) || 8))
      .sort((a, b) => {
        const ap = Number(a.players) || 0;
        const bp = Number(b.players) || 0;
        if (ap === 1 && bp !== 1) return -1;
        if (bp === 1 && ap !== 1) return 1;
        return ap - bp;
      });
    if (free.length) {
      this.joinRoom(free[0].id || free[0].room);
      return;
    }
    this.showToast(t('No open tables — starting a bot game.'), 'ok');
    this.openBotSetup();
  }

  async joinRoom(ref) {
    if (this.joining || !ref) return;
    this.joining = true;
    this.renderRooms();
    try {
      await this.prepareIdentity();
      this.net.joinRoom(ref);
    } catch {
      this.joining = false;
      this.renderRooms();
      this.showToast(t('Could not reach the server.'), 'error');
    }
  }

  enterGame(detail) {
    this.offline = false;
    this.session = this.onlineSession;
    this.suppressTurnToast = true;
    this.lastViewColor = null;
    this.hasRenderedBoard = false;
    this.lastFen = '';
    this.selected = null;
    this.legal = [];
    this.resultKey = '';
    this.resumeRetried = false;
    this.suspendedSeat = 0;
    this.holdUntil = 0;
    $('game').classList.remove('offline');
    $('copyBtn').hidden = false;
    $('lobby').hidden = true;
    $('game').hidden = false;
    document.body.classList.add('in-game');
    const room = detail.room;
    $('roomTitle').textContent = room.name;
    $('roomKicker').textContent = `${t('Table')} #${room.id}`;
    $('inviteCode').textContent = room.id || '————————';
    this.scene.setMode('game');
    this.scene.clearSelection();
    const url = new URL(location.href);
    url.searchParams.set('room', room.id || room.name);
    history.replaceState(null, '', url);
    this.renderGame();
    if (this.session.game) this.syncBoardFromSnapshot(this.session.snapshot());
    if (detail.resumed) this.showToast(t('You are back at your table.'), 'ok');
    else if (detail.created) this.showToast(t('Table is open. Invite a friend by link.'), 'ok');
    else this.showToast(t('You are at the table.'), 'ok');
  }

  botLevelName(level) {
    return t({ easy: 'Novice', medium: 'Club player', master: 'Maestro' }[level] || 'Club player');
  }

  openBotSetup() {
    const levels = [
      { id: 'easy', icon: '♟', title: t('Novice'), text: t('A relaxed opponent. Sees one move ahead.'), depth: t('1 move') },
      { id: 'medium', icon: '♞', title: t('Club player'), text: t('A steady opponent. Looks two moves ahead.'), depth: t('2 moves') },
      { id: 'master', icon: '♛', title: t('Maestro'), text: t('Deep calculation, captures and a short endgame search.'), depth: t('4 moves') },
    ];
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <button class="icon-btn icon-btn--small modal__close" id="botClose" aria-label="${t('Close')}"><svg><use href="#i-close"></use></svg></button>
      <p class="panel-kicker">${t('Offline salon')}</p>
      <h2>${t('Play vs bot')}</h2>
      <p>${t('No network, no waiting. Pick an opponent and a side.')}</p>
      <div class="bot-levels" id="botLevels">
        ${levels.map((level) => `
          <button class="bot-level${level.id === this.botSetupLevel ? ' is-selected' : ''}" type="button" data-level="${level.id}">
            <span class="bot-level__icon">${level.icon}</span>
            <span class="bot-level__text"><strong>${level.title}</strong><small>${level.text}</small></span>
            <span class="bot-level__depth">${level.depth}</span>
          </button>
        `).join('')}
      </div>
      <p class="field-label" style="margin-top:22px">${t('Your side')}</p>
      <div class="side-choice" id="botSides">
        <button class="side-btn${this.botSetupColor === 'w' ? ' is-selected' : ''}" type="button" data-side="w"><span>♔</span>${t('White')}</button>
        <button class="side-btn${this.botSetupColor === 'b' ? ' is-selected' : ''}" type="button" data-side="b"><span>♚</span>${t('Black')}</button>
        <button class="side-btn${this.botSetupColor === 'r' ? ' is-selected' : ''}" type="button" data-side="r"><span>♠</span>${t('Random')}</button>
      </div>
      <div class="modal__actions">
        <button class="btn btn--ghost btn--compact" id="botCancel" type="button">${t('Cancel')}</button>
        <button class="btn btn--gold btn--compact" id="botStart" type="button">${t('Start game')}</button>
      </div>
    `;
    const levelButtons = modal.querySelectorAll('[data-level]');
    for (const btn of levelButtons) {
      btn.addEventListener('click', () => {
        this.botSetupLevel = btn.dataset.level;
        levelButtons.forEach((item) => item.classList.toggle('is-selected', item === btn));
      });
    }
    const sideButtons = modal.querySelectorAll('[data-side]');
    for (const btn of sideButtons) {
      btn.addEventListener('click', () => {
        this.botSetupColor = btn.dataset.side;
        sideButtons.forEach((item) => item.classList.toggle('is-selected', item === btn));
      });
    }
    modal.querySelector('#botClose').addEventListener('click', () => this.closeModal());
    modal.querySelector('#botCancel').addEventListener('click', () => this.closeModal());
    modal.querySelector('#botStart').addEventListener('click', () => {
      this.closeModal();
      this.startOffline(this.botSetupLevel, this.botSetupColor);
    });
    this.openModal(modal, { focus: modal.querySelector('#botStart') });
  }

  startOffline(level, color) {
    this.stopOfflineSession();
    this.name = cleanName(this.nameInput.value);
    this.nameInput.value = this.name;
    store('ornate-chess:name', this.name);
    this.updateSeal();
    const chosen = color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    this.offline = true;
    this.offlineLevel = level;
    this.offlineColor = chosen;
    this.botColor = chosen === 'w' ? 'b' : 'w';
    this.botName = this.botLevelName(level);
    this.botThinking = false;
    this.botRequestId += 1;
    this.offlineNet = new LocalNet({ playerName: this.name, botName: this.botName, playerColor: chosen });
    this.offlineSession = new ChessSession(this.offlineNet);
    this.session = this.offlineSession;
    this.bindSession(this.offlineSession);
    this.enterOfflineGame();
    this.offlineNet.start();
    this.maybeBotMove();
  }

  enterOfflineGame() {
    this.suppressTurnToast = true;
    this.lastViewColor = null;
    this.hasRenderedBoard = false;
    this.lastFen = '';
    this.selected = null;
    this.legal = [];
    this.resultKey = '';
    this.closeResult();
    $('game').classList.add('offline');
    $('copyBtn').hidden = true;
    $('lobby').hidden = true;
    $('game').hidden = false;
    document.body.classList.add('in-game');
    $('roomTitle').textContent = this.botName;
    $('roomKicker').textContent = `${t('Offline salon')} · ${this.botLevelName(this.offlineLevel)}`;
    $('inviteCode').textContent = '————————';
    $('inviteStrip').hidden = true;
    this.scene.setMode('game');
    this.scene.clearSelection();
    this.clearRoomQuery();
    this.renderGame();
    if (this.session.game) this.syncBoardFromSnapshot(this.session.snapshot());
  }

  stopOfflineSession() {
    clearTimeout(this.botTimer);
    clearTimeout(this.botWatchdog);
    this.botTimer = null;
    this.botWatchdog = null;
    this.botThinking = false;
    this.botRequestId += 1;
    if (this.offlineSession) {
      this.offlineSession.destroy();
      this.offlineSession = null;
    }
    this.offlineNet = null;
    this.offline = false;
    this.session = this.onlineSession;
    $('game').classList.remove('offline');
    $('copyBtn').hidden = false;
  }

  clearBotWatchdog() {
    clearTimeout(this.botWatchdog);
    this.botWatchdog = null;
  }

  ensureBotWorker() {
    if (this.botWorker || this.botWorkerBroken || typeof Worker === 'undefined') return;
    try {
      this.botWorker = new Worker(new URL('./bot-worker.js?v=20261028-14', import.meta.url), { type: 'module' });
      this.botWorker.onmessage = (event) => {
        const { id, move } = event.data || {};
        if (id !== this.botRequestId) return;
        this.clearBotWatchdog();
        this.botThinking = false;
        if (!this.offline || !this.session?.isPlaying) return;
        if (move) this.applyBotMove(move);
        else this.runBotFallback();
      };
      this.botWorker.onerror = () => {
        this.botWorkerBroken = true;
        this.botWorker = null;
        this.clearBotWatchdog();
        this.botRequestId += 1;
        if (this.botThinking) {
          this.botThinking = false;
          this.runBotFallback();
        }
      };
    } catch {
      this.botWorkerBroken = true;
      this.botWorker = null;
    }
  }

  maybeBotMove() {
    if (!this.offline || this.botThinking || !this.session?.isPlaying) return;
    if (this.session.pending) {
      clearTimeout(this.botTimer);
      this.botTimer = setTimeout(() => this.maybeBotMove(), 180);
      return;
    }
    this.botColor = this.session.myColor === 'w' ? 'b' : 'w';
    if (!this.session.chess || this.session.chess.turn() !== this.botColor) return;
    this.botThinking = true;
    clearTimeout(this.botTimer);
    this.botTimer = setTimeout(() => this.requestBotMove(), 420 + Math.random() * 520);
  }

  requestBotMove() {
    if (!this.offline || !this.session?.isPlaying || this.session.chess.turn() !== this.botColor) {
      this.botThinking = false;
      return;
    }
    const id = ++this.botRequestId;
    const fen = this.session.chess.fen();
    this.ensureBotWorker();
    if (this.botWorker) {
      this.botWorker.postMessage({ id, fen, level: this.offlineLevel });
      this.clearBotWatchdog();
      this.botWatchdog = setTimeout(() => {
        if (id !== this.botRequestId || !this.botThinking) return;
        this.botWorkerBroken = true;
        try {
          this.botWorker?.terminate();
        } catch {
          /* noop */
        }
        this.botWorker = null;
        this.botThinking = false;
        this.botRequestId += 1;
        this.clearBotWatchdog();
        this.runBotFallback();
      }, 7000);
    } else {
      setTimeout(() => {
        if (id !== this.botRequestId || !this.offline) return;
        try {
          const move = chooseBotMove(fen, this.offlineLevel);
          this.botThinking = false;
          if (move) this.applyBotMove(move);
        } catch {
          this.botThinking = false;
        }
      }, 30);
    }
  }

  runBotFallback() {
    this.clearBotWatchdog();
    if (!this.offline || !this.session?.isPlaying) return;
    try {
      const move = chooseBotMove(this.session.chess.fen(), this.offlineLevel);
      this.botThinking = false;
      if (move) this.applyBotMove(move);
    } catch {
      this.botThinking = false;
    }
  }

  applyBotMove(move) {
    this.botThinking = false;
    if (!this.offline || !move) return;
    const result = this.session.tryColorMove(move.from, move.to, move.promotion || '', this.botColor);
    if (result === 'pending') {
      clearTimeout(this.botTimer);
      this.botTimer = setTimeout(() => this.maybeBotMove(), 160);
      return;
    }
    if (result !== 'ok') {
      const legal = this.session.chess?.moves({ verbose: true }) || [];
      const fallback = legal[Math.floor(Math.random() * legal.length)];
      if (fallback && this.session.chess.turn() === this.botColor) {
        this.session.tryColorMove(fallback.from, fallback.to, fallback.promotion || '', this.botColor);
      }
    }
  }

  enterLobby() {
    if (this.offline) this.stopOfflineSession();
    this.session = this.onlineSession;
    this.clearRoomQuery();
    this.suspendedSeat = 0;
    this.holdUntil = 0;
    this.presenceWasMine = false;
    saveResumeHint(null);
    if ($('presenceBar')) $('presenceBar').hidden = true;
    $('game').hidden = true;
    $('lobby').hidden = false;
    $('game').classList.remove('view-black');
    document.body.classList.remove('in-game');
    this.hasRenderedBoard = false;
    this.lastFen = '';
    this.selected = null;
    this.legal = [];
    this.closeResult();
    $('inviteStrip').hidden = false;
    this.scene.setMode('lobby');
    this.scene.clearSelection();
    this.scene.setCheck(null);
    this.scene.clearBoard();
    this.scene.setPosition(START_FEN, { initial: true });
    this.hasRenderedBoard = true;
    this.lastFen = START_FEN;
    this.renderRooms();
    this.net.listRooms();
  }

  clearRoomQuery() {
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
  }

  /* ---------------------------------------------------------------- game */
  syncBoardFromSnapshot(snapshot) {
    const game = snapshot.game;
    if (!game || !this.gnet.room) return;
    const viewColor = snapshot.myColor || 'w';
    if (viewColor !== this.lastViewColor) {
      this.lastViewColor = viewColor;
      this.scene.setViewSide(viewColor);
    }
    if (!this.hasRenderedBoard) {
      this.scene.clearBoard();
      this.scene.setPosition(game.fen, { initial: true, lastMove: game.lastMove });
      this.lastFen = game.fen;
      this.hasRenderedBoard = true;
    } else if (game.fen !== this.lastFen) {
      if (!game.lastMove || game.moves.length === 0) {
        this.scene.clearBoard();
        this.scene.setPosition(game.fen, { initial: true, lastMove: game.lastMove });
        this.lastFen = game.fen;
      }
    }
    this.updateBoardMarkers();
  }

  updateBoardMarkers() {
    const chess = this.session.chess;
    const game = this.session.game;
    if (!chess || !game || game.status !== 'playing') {
      this.scene.setCheck(null);
      return;
    }
    if (chess.inCheck()) {
      let king = null;
      for (const row of chess.board()) {
        for (const sq of row) {
          if (sq && sq.type === 'k' && sq.color === chess.turn()) king = sq.square;
        }
      }
      this.scene.setCheck(king);
    } else {
      this.scene.setCheck(null);
    }
  }

  moveCountLabel(n) {
    if (isRussian()) return `${n} ${pluralRu(n, 'ход', 'хода', 'ходов')}`;
    return `${n} ${n === 1 ? 'move' : 'moves'}`;
  }

  renderGame() {
    if ($('game').hidden) return;
    const game = this.session.game;
    const room = this.gnet.room;
    if (!room) return;

    if (!game) {
      $('statusTitle').textContent = t('The host is preparing the table');
      $('statusText').textContent = t('The game will appear here in a moment.');
      $('phaseLabel').textContent = t('Table');
      $('turnPill').textContent = '—';
      $('turnPill').className = 'turn-pill';
      this.syncInteraction();
      return;
    }

    const white = this.session.playerFor('w');
    const black = this.session.playerFor('b');
    const myColor = this.session.myColor;
    const turn = game.status === 'playing' ? this.session.turn : null;
    $('game').classList.toggle('view-black', myColor === 'b');

    this.renderPlayerCard('white', white, 'w', turn);
    this.renderPlayerCard('black', black, 'b', turn);
    this.renderMoves(game);
    this.renderResult(game, white, black);
    this.updateDrawOffer(game);
    this.updateStatusCopy(game, white, black, myColor, turn);

    $('inviteCode').textContent = room.id || '————————';
    $('inviteStrip').hidden = this.offline || (!!game.blackId && game.status === 'playing');
    $('copyBtn').hidden = this.offline;
    $('spectatorBadge').hidden = !this.session.isSpectator;
    $('spectatorHint').hidden = !(this.session.isSpectator && game.blackId && game.whiteId && !this.offline);
    $('moveCount').textContent = this.moveCountLabel(Math.ceil(game.moves.length / 2));
    $('openingName').textContent = openingName(game.moves, getLocale());
    this.updateClock();
    this.syncPresence(game, myColor);
    this.saveResume(game, room);

    $('drawBtn').hidden = this.offline;
    $('drawBtn').disabled = this.offline || !this.session.isPlaying || !!game.drawOffer || this.session.pending;
    $('resignBtn').disabled = !this.session.isPlaying;
    $('hintBtn').disabled = !this.session.isPlaying || this.session.pending;
    $('rematchBtn').hidden = game.status === 'playing' || game.status === 'waiting';
    $('rematchBtn').disabled = !this.session.isHost;
    $('resultRematchBtn').disabled = !this.session.isHost;
    $('resultRematchBtn').textContent = this.session.isHost ? t('Rematch') : t('Host rematch');
    $('resultRematchBtn').title = this.session.isHost ? t('Start a new game') : t('The host starts the next game');

    this.syncInteraction();
  }

  renderPlayerCard(side, player, color, turn) {
    const prefix = side;
    const card = $(`${prefix}Card`);
    const name = $(`${prefix}Name`);
    const meta = $(`${prefix}Meta`);
    const avatar = $(`${prefix}Avatar`);
    const turnPill = $(`${prefix}Turn`);
    const isMe = player && player.id === this.gnet.you;
    const active = player && player.status !== 'suspended' && player.status !== 'gone';
    card.classList.toggle('is-you', !!isMe);
    if (isMe) card.dataset.youLabel = t('you');
    else delete card.dataset.youLabel;
    card.classList.toggle('is-turn', turn === color);
    turnPill.textContent = turn === color ? t('move') : '';
    avatar.textContent = color === 'w' ? '♔' : '♚';
    if (!player) {
      name.textContent = t('Free seat');
      meta.textContent = color === 'b' ? t('waiting for a guest · feel free to invite') : t("host's seat");
      card.classList.remove('is-you');
      this.fillCaptures(side, []);
      return;
    }
    name.textContent = player.name || t('Player #{id}', { id: player.id });
    if (this.offline) {
      meta.textContent = player.id === 2 ? t('Bot · {level}', { level: this.botLevelName(this.offlineLevel) }) : t('Offline game');
    } else if (!active) meta.textContent = t('disconnected · seat held');
    else if (player.id === this.gnet.hostId) meta.textContent = t('table host · #{id}', { id: player.id });
    else meta.textContent = t('guest · #{id}', { id: player.id });
    const captures = this.session.capturedBy(color);
    this.fillCaptures(side, captures);
    const diff = this.session.material().diff;
    const advantage = color === 'w' ? diff : -diff;
    if (advantage > 0) meta.textContent += ` · +${advantage}`;
  }

  fillCaptures(side, captures) {
    const host = $(`${side}Card`);
    let box = host.querySelector('.player-card__captures');
    if (!box) {
      box = document.createElement('span');
      box.className = 'player-card__captures';
      host.querySelector('.player-card__body').appendChild(box);
    }
    box.innerHTML = '';
    const sorted = [...captures].sort((a, b) => PIECE_ORDER.indexOf(a.type) - PIECE_ORDER.indexOf(b.type));
    for (const piece of sorted) {
      const span = document.createElement('span');
      span.textContent = pieceGlyph(piece.type, piece.color);
      span.title = piece.type;
      box.appendChild(span);
    }
  }

  renderMoves(game) {
    const list = $('moveList');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 45;
    if (!game.moves.length) {
      list.innerHTML = `<li class="move-list__empty">${t('The first move is still ahead.')}</li>`;
      return;
    }
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < game.moves.length; i += 2) {
      const li = document.createElement('li');
      li.className = 'move-pair';
      const no = document.createElement('span');
      no.className = 'move-pair__no';
      no.textContent = `${i / 2 + 1}.`;
      const white = document.createElement('span');
      white.className = 'move-pair__san';
      white.textContent = game.moves[i] || '';
      if (i === game.moves.length - 1) white.classList.add('is-last');
      const black = document.createElement('span');
      black.className = 'move-pair__san';
      black.textContent = game.moves[i + 1] || '';
      if (i + 1 === game.moves.length - 1) black.classList.add('is-last');
      if (!game.moves[i + 1]) black.classList.add('move-pair__san--empty');
      li.append(no, white, black);
      fragment.appendChild(li);
    }
    list.innerHTML = '';
    list.appendChild(fragment);
    if (nearBottom) requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  }

  updateStatusCopy(game, white, black, myColor, turn) {
    const title = $('statusTitle');
    const text = $('statusText');
    const phase = $('phaseLabel');
    const pill = $('turnPill');

    if (game.status === 'waiting' || !game.blackId) {
      phase.textContent = t('Table open');
      title.textContent = t('Waiting for opponent');
      text.textContent = t('The link is ready. Send it to a friend and the game will begin.');
      pill.textContent = t('waiting');
      pill.className = 'turn-pill';
      return;
    }

    if (game.status === 'playing') {
      phase.textContent = t('Game in progress');
      const turnLabel = t(turn === 'w' ? 'White to move' : 'Black to move');
      const opponent = turn === myColor ? null : this.playerName(turn === 'w' ? game.whiteId : game.blackId);
      if (myColor && turn === myColor) {
        title.textContent = this.session.inCheck ? t('Check — your move') : t('Your move');
        text.textContent = t('Choose a piece on the board, then a square. Highlighted dots are legal moves.');
        pill.textContent = t('your move');
        pill.className = 'turn-pill is-mine';
      } else if (myColor) {
        title.textContent = t('{name} is thinking', { name: opponent || t('Opponent') });
        text.textContent = this.session.inCheck ? t('Opponent is in check. Watch their reply.') : t("Opponent's turn. Study the position or offer a draw.");
        pill.textContent = turnLabel;
        pill.className = 'turn-pill';
      } else {
        title.textContent = t('Game in progress');
        text.textContent = t('{white} vs {black}. You are watching the table.', {
          white: this.playerName(game.whiteId),
          black: this.playerName(game.blackId),
        });
        pill.textContent = turnLabel;
        pill.className = 'turn-pill';
      }
      return;
    }

    phase.textContent = t('Game over');
    pill.textContent = t('result');
    pill.className = 'turn-pill';
    title.textContent = this.resultTitle(game);
    text.textContent = this.resultDescription(game, white, black);
    if (myColor && game.winner === myColor) text.textContent += ` ${t('Congratulations — that is your win.')}`;
  }

  resultTitle(game) {
    switch (game.status) {
      case 'checkmate': return t('Checkmate');
      case 'resigned': return t('Resignation');
      case 'abandoned': return t('Table abandoned');
      case 'stalemate': return t('Stalemate');
      case 'draw': return t('Draw');
      default: return t('Game over');
    }
  }

  resultDescription(game, white, black) {
    const winnerName = game.winner ? this.playerName(game.winner === 'w' ? game.whiteId : game.blackId) : null;
    if (game.status === 'checkmate') {
      return t('Checkmate. {winner} takes the game.', {
        winner: winnerName || t(game.winner === 'w' ? 'White' : 'Black'),
      });
    }
    if (game.status === 'resigned') {
      return t('{winner} wins by resignation.', { winner: winnerName || t('Opponent') });
    }
    if (game.status === 'abandoned') {
      return t('{winner} remains at the table and takes the game.', { winner: winnerName || t('Opponent') });
    }
    if (game.status === 'stalemate') return t('The king is not in check, but there are no legal moves. Stalemate.');
    const reasons = {
      agreement: 'The opponents agreed to a draw.',
      material: 'There is not enough material on the board for checkmate.',
      repetition: 'The position repeated three times.',
      fifty: 'The fifty-move rule.',
      draw: 'The game ended in a draw.',
    };
    return reasons[game.reason] ? t(reasons[game.reason]) : t('The game ended in a draw.');
  }

  resultKeyFor(game) {
    return `${game.rev}:${game.status}:${game.winner || ''}`;
  }

  renderResult(game, white, black) {
    const card = $('resultCard');
    if (game.status === 'playing' || game.status === 'waiting') {
      card.hidden = true;
      this.resultKey = '';
      return;
    }
    const key = this.resultKeyFor(game);
    const fresh = key !== this.resultKey;
    this.resultKey = key;
    card.hidden = false;
    const winner = game.winner;
    $('resultSigil').textContent = winner ? (winner === 'w' ? '♔' : '♚') : '½';
    $('resultKicker').textContent = game.status === 'draw' || game.status === 'stalemate' ? t('Draw') : t('Game over');
    $('resultTitle').textContent = this.resultTitle(game);
    $('resultText').textContent = this.resultDescription(game, white, black);
    if (fresh && !card.classList.contains('is-visible')) {
      requestAnimationFrame(() => card.classList.add('is-visible'));
    }
  }

  closeResult() {
    $('resultCard').hidden = true;
    $('resultCard').classList.remove('is-visible');
    this.resultKey = '';
  }

  updateDrawOffer(game) {
    const bar = $('drawOfferBar');
    const fromOpponent = this.session.drawOfferFromOpponent();
    bar.hidden = !fromOpponent;
    if (fromOpponent) {
      $('drawOfferText').textContent = t('{name} offers a draw.', { name: this.playerName(game.drawOffer) });
    }
  }

  updateClock() {
    if ($('game').hidden) return;
    const game = this.session.game;
    if (!game) {
      $('gameClock').textContent = '00:00';
      return;
    }
    const from = game.startedAt || game.createdAt || Date.now();
    $('gameClock').textContent = formatClock(Date.now() - from);
    this.renderPresence();
  }

  playerName(id) {
    if (!id) return t('Opponent');
    if (id === this.gnet.you) return this.gnet.welcomeInfo?.name || this.name;
    const player = this.gnet.players.get(id);
    return player?.name || t('Player #{id}', { id });
  }

  showTurnToast(text) {
    const el = $('turnToast');
    $('turnToastText').textContent = text;
    el.classList.add('is-visible');
    clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
  }

  syncInteraction() {
    const allowed = !!this.gnet.room && this.gnet.connected && this.session.isPlaying && !this.session.pending && !this.modalOpen;
    this.scene.setInteractive(allowed);
    this.syncSelectionVisual();
  }

  syncSelectionVisual() {
    if (!this.selected) {
      this.scene.clearSelection();
      return;
    }
    const piece = this.session.chess?.get(this.selected);
    if (!piece || piece.color !== this.session.myColor) {
      this.selected = null;
      this.legal = [];
      this.scene.clearSelection();
      return;
    }
    const legal = this.session.game?.status === 'playing' && this.session.chess.turn() === this.session.myColor
      ? this.session.legalMoves(this.selected)
      : [];
    this.legal = legal;
    this.scene.selectSquare(this.selected, legal);
  }

  /* ------------------------------------------------------------- actions */
  onGlobalPointerUp(event) {
    const start = this.globalDown;
    this.globalDown = null;
    if (!start || event.button !== 0 || $('game').hidden || this.modalOpen) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > (event.pointerType === 'touch' ? 16 : 8)) return;
    if (!this.net.room && !this.offline) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, a, input, textarea, select, .topbar, .game-panel, .player-card, .board-controls, .result-card, .draw-offer, .turn-toast, .spectator-hint, .modal-root')) {
      return;
    }
    const square = this.scene.squareFromPoint(event.clientX, event.clientY);
    if (square) {
      event.preventDefault();
      this.onSquareClick(square);
    }
  }

  onSquareClick(square) {
    if (!square || this.modalOpen || !this.gnet.connected || !this.gnet.room) return;
    const game = this.session.game;
    if (!game) return;
    if (this.session.pending) return;

    if (game.status === 'waiting') {
      if (this.session.myColor && this.session.chess?.get(square)?.color === this.session.myColor) {
        this.selectSquare(square);
      } else {
        this.showTurnToast(t('Waiting for opponent'));
      }
      return;
    }
    if (game.status !== 'playing') return;
    if (!this.session.myColor) {
      this.showTurnToast(t('You are watching'));
      return;
    }

    if (this.selected) {
      if (square === this.selected) {
        this.selected = null;
        this.legal = [];
        this.scene.clearSelection();
        return;
      }
      const own = this.session.chess?.get(square);
      if (own && own.color === this.session.myColor) {
        this.selectSquare(square);
        return;
      }
      if (this.session.chess?.turn() !== this.session.myColor) {
        this.showTurnToast(t('Wait for your turn'));
        return;
      }
      const candidates = this.legal.filter((m) => m.to === square);
      if (candidates.length) {
        const needsPromotion = candidates.some((m) => m.promotion);
        if (needsPromotion) {
          this.askPromotion(this.selected, square);
        } else {
          this.commitMove(this.selected, square, '');
        }
        return;
      }
      this.selected = null;
      this.legal = [];
      this.scene.clearSelection();
      return;
    }
    this.selectSquare(square);
  }

  selectSquare(square) {
    const piece = this.session.chess?.get(square);
    if (!piece || piece.color !== this.session.myColor) {
      this.scene.clearSelection();
      return;
    }
    this.selected = square;
    this.legal = this.session.game?.status === 'playing' && this.session.chess.turn() === this.session.myColor
      ? this.session.legalMoves(square)
      : [];
    this.scene.selectSquare(square, this.legal);
    if (this.session.game?.status === 'waiting') {
      this.showTurnToast(t('Waiting for opponent'));
    } else if (this.session.chess.turn() !== this.session.myColor) {
      this.showTurnToast(t('Wait for your turn'));
    } else {
      this.audio.select();
    }
  }

  commitMove(from, to, promotion) {
    const result = this.session.tryMove(from, to, promotion);
    this.selected = null;
    this.legal = [];
    this.scene.clearSelection();
    if (result === 'not-your-turn') this.showToast(t('It is not your turn.'), 'error');
    else if (result === 'pending') this.showToast(t('The previous move is still being confirmed.'));
    else if (result === 'not-playing') this.showToast(t('The game is not running.'), 'error');
    else if (result === 'illegal') this.showToast(t('That move is not legal.'), 'error');
    else if (result === 'promotion') this.showToast(t('Choose a promotion piece.'));
    this.syncInteraction();
  }

  askPromotion(from, to) {
    const color = this.session.myColor;
    const options = ['q', 'r', 'b', 'n'];
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <button class="icon-btn icon-btn--small modal__close" id="promoClose" aria-label="${t('Close')}"><svg><use href="#i-close"></use></svg></button>
      <p class="panel-kicker">${t('Promotion')}</p>
      <h2>${t('Choose a piece')}</h2>
      <p>${t('The pawn reached the last rank. What will it become?')}</p>
      <div class="promo-grid" id="promoGrid"></div>
    `;
    const grid = modal.querySelector('#promoGrid');
    const labels = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
    for (const type of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'promo-btn';
      btn.innerHTML = `<span>${pieceGlyph(type, color)}</span><small>${t(labels[type])}</small>`;
      btn.addEventListener('click', () => {
        this.closeModal();
        this.commitMove(from, to, type);
      });
      grid.appendChild(btn);
    }
    this.openModal(modal, { focus: grid.querySelector('button') });
    modal.querySelector('#promoClose').addEventListener('click', () => this.closeModal());
  }

  askDraw() {
    if (!this.session.isPlaying) return;
    if (this.session.game?.drawOffer === this.gnet.you) {
      this.showToast(t('Draw offer already sent.'));
      return;
    }
    if (this.session.game?.drawOffer) {
      this.session.acceptDraw();
      return;
    }
    this.session.offerDraw();
  }

  confirmResign() {
    if (!this.session.isPlaying) return;
    this.confirm({
      kicker: t('Resign'),
      title: t('Resign the game?'),
      text: t('The game ends immediately with a win for your opponent. Your salon rating is not affected — people play here for pleasure.'),
      confirm: t('Resign'),
      danger: true,
      onConfirm: () => {
        this.session.resign();
        this.closeModal();
      },
    });
  }

  rematch() {
    if (!this.session.isHost) {
      this.showToast(t('Only the host can start a new game.'), 'error');
      return;
    }
    if (this.session.game?.status === 'playing') return;
    if (this.session.newGame()) {
      this.closeResult();
      this.lastViewColor = null;
      this.scene.setViewSide(this.session.myColor || 'w');
      this.showToast(t('New game! The pieces are ready.'), 'ok');
    }
  }

  confirmLeave() {
    if (this.offline) {
      if (this.session.isPlaying) {
        this.confirm({
          kicker: t('Leave table'),
          title: t('Leave the game?'),
          text: t('The offline game will be lost. You can start a new one from the lobby at any time.'),
          confirm: t('Leave to lobby'),
          danger: true,
          onConfirm: () => {
            this.closeModal();
            this.enterLobby();
          },
        });
      } else {
        this.enterLobby();
      }
      return;
    }
    if (!this.net.room) return;
    if (this.session.isPlaying) {
      this.confirm({
        kicker: t('Leave table'),
        title: t('Leave the table?'),
        text: t('You will return to the lobby and your opponent gets the win. You can come back by link, but the game will already be over.'),
        confirm: t('Leave to lobby'),
        danger: true,
        onConfirm: () => {
          this.closeModal();
          this.net.leaveRoom();
        },
      });
    } else {
      this.net.leaveRoom();
    }
  }

  giveHint() {
    if (!this.session.isPlaying || this.hintBusy) return;
    this.hintBusy = true;
    $('hintBtn').disabled = true;
    setTimeout(() => {
      const clone = this.session.cloneForHint();
      const hint = clone ? findHint(clone, 3) : null;
      this.hintBusy = false;
      $('hintBtn').disabled = !this.session.isPlaying;
      if (!hint) {
        this.showToast(t('No hint found — the position is already decided.'));
        return;
      }
      this.scene.setHint(hint);
      this.showToast(t('Hint: {san}', { san: hint.san }), 'ok');
      this.audio.select();
    }, 30);
  }

  async copyInvite() {
    const room = this.gnet.room;
    if (!room) return;
    const link = roomUrl(room.id || room.name);
    const ok = await copyText(link);
    this.showToast(ok ? t('Table link copied.') : link, ok ? 'ok' : 'error');
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      if (this.modalOpen) {
        this.closeModal();
        return;
      }
      if (this.selected) {
        this.selected = null;
        this.legal = [];
        this.scene.clearSelection();
      }
      return;
    }
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (this.modalOpen) return;
    if (e.key === 'r' || e.key === 'R') this.scene.resetCamera();
    if (e.key === 'f' || e.key === 'F') this.scene.flipView();
    if (e.key === 't' || e.key === 'T') this.scene.topView();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.key === 'ArrowLeft') this.scene.orbitBy(-0.16);
      if (e.key === 'ArrowRight') this.scene.orbitBy(0.16);
      if (e.key === 'ArrowUp') this.scene.orbitBy(0, -0.09);
      if (e.key === 'ArrowDown') this.scene.orbitBy(0, 0.09);
    }
    if (e.key === '+' || e.key === '=') this.scene.zoomBy(0.9);
    if (e.key === '-' || e.key === '_') this.scene.zoomBy(1.1);
    if (e.key === 'm' || e.key === 'M') {
      const on = this.audio.toggle();
      this.refreshSoundButton();
      this.showToast(t(on ? 'Sound on' : 'Sound off'));
    }
    if (e.key === '?') this.openHelp();
  }

  refreshSoundButton() {
    const btn = $('soundBtn');
    btn.classList.toggle('is-muted', !this.audio.enabled);
    btn.setAttribute('aria-label', t(this.audio.enabled ? 'Mute sound' : 'Unmute sound'));
    btn.querySelector('use').setAttribute('href', this.audio.enabled ? '#i-sound' : '#i-mute');
  }

  /* --------------------------------------------------------------- modal */
  openModal(content, { focus } = {}) {
    const root = $('modalRoot');
    if (this.modalOpen) this.closeModal(true);
    this.lastFocus = document.activeElement;
    root.innerHTML = '';
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    root.append(backdrop, content);
    root.classList.add('has-modal');
    requestAnimationFrame(() => root.classList.add('is-open'));
    this.modalOpen = true;
    this.syncInteraction();
    setTimeout(() => {
      const target = focus || content.querySelector('button, input, [tabindex="0"]');
      target?.focus?.();
    }, 60);
  }

  closeModal(silent = false) {
    const root = $('modalRoot');
    root.classList.remove('is-open');
    root.classList.remove('has-modal');
    this.modalOpen = false;
    setTimeout(() => {
      if (!this.modalOpen) root.innerHTML = '';
    }, 260);
    if (!silent) {
      this.lastFocus?.focus?.();
      this.lastFocus = null;
    }
    this.syncInteraction();
  }

  confirm({ kicker = t('Confirmation'), title, text, confirm = t('Confirm'), danger = false, onConfirm }) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <button class="icon-btn icon-btn--small modal__close" id="confirmClose" aria-label="${t('Close')}"><svg><use href="#i-close"></use></svg></button>
      <p class="panel-kicker">${escapeHtml(kicker)}</p>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(text)}</p>
      <div class="modal__actions">
        <button class="btn btn--ghost btn--compact" id="confirmCancel" type="button">${t('Cancel')}</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--gold'} btn--compact" id="confirmYes" type="button">${escapeHtml(confirm)}</button>
      </div>
    `;
    modal.querySelector('#confirmClose').addEventListener('click', () => this.closeModal());
    modal.querySelector('#confirmCancel').addEventListener('click', () => this.closeModal());
    modal.querySelector('#confirmYes').addEventListener('click', () => {
      onConfirm?.();
    });
    this.openModal(modal, { focus: modal.querySelector('#confirmCancel') });
  }

  openHelp() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <button class="icon-btn icon-btn--small modal__close" id="helpClose" aria-label="${t('Close')}"><svg><use href="#i-close"></use></svg></button>
      <p class="panel-kicker">Ornate · 3D Chess Salon</p>
      <h2>${t('How to play')}</h2>
      <p>${t('Choose a table in the lounge or open your own. The first guest plays White, the second plays Black, everyone else watches.')}</p>
      <div class="help-grid">
        <div class="help-item"><span class="help-item__icon">♟</span><div><strong>${t('Move')}</strong><p>${t('Click your piece, then a highlighted square. Dots are empty squares, rings are captures.')}</p></div></div>
        <div class="help-item"><span class="help-item__icon">♜</span><div><strong>${t('Camera')}</strong><p>${t('Drag the board with the mouse or a finger to spin the camera, the wheel or a pinch zooms, and “Top view” lays the board flat for a clean plan.')}</p></div></div>
        <div class="help-item"><span class="help-item__icon">♞</span><div><strong>${t('Opponent')}</strong><p>${t('Send a friend the table link. They will land straight in the game. For two players on one computer, a private window or a second browser profile is best.')}</p></div></div>
        <div class="help-item"><span class="help-item__icon">♛</span><div><strong>${t('Fair play')}</strong><p>${t('The server relays the position and moves, while the rules are checked on the client. This is a friendly salon, not an anti-cheat tournament.')}</p></div></div>
        <div class="help-item"><span class="help-item__icon">✦</span><div><strong>${t('Keys')}</strong><p>${t('<b>R</b> — camera, <b>F</b> — flip, <b>M</b> — sound, <b>Esc</b> — close a window.')}</p></div></div>
      </div>
      <div class="modal__actions">
        <button class="btn btn--gold btn--compact" id="helpOk" type="button">${t('Got it')}</button>
      </div>
      <p style="margin:18px 0 0;font-size:9px;color:var(--muted-2)">${t('StarkFlow WebSocket · Three.js · no sign-up or installation')}</p>
    `;
    modal.querySelector('#helpClose').addEventListener('click', () => this.closeModal());
    modal.querySelector('#helpOk').addEventListener('click', () => this.closeModal());
    this.openModal(modal, { focus: modal.querySelector('#helpOk') });
  }

  /* ------------------------------------------------------------- presence */
  syncPresence(game, myColor) {
    if (this.offline || !myColor || game.status !== 'playing') {
      this.suspendedSeat = 0;
      this.holdUntil = 0;
      this.renderPresence();
      return;
    }
    const opponentId = myColor === 'w' ? game.blackId : game.whiteId;
    const opponent = opponentId ? this.gnet.players.get(opponentId) : null;
    if (opponent && opponent.status === 'suspended') {
      if (this.suspendedSeat !== opponentId) {
        this.suspendedSeat = opponentId;
        this.holdUntil = Date.now() + SUSPEND_HOLD_MS;
      }
    } else if (this.suspendedSeat === opponentId) {
      this.suspendedSeat = 0;
      this.holdUntil = 0;
    }
    this.renderPresence();
  }

  renderPresence() {
    const bar = $('presenceBar');
    if (!bar) return;
    const net = this.gnet;
    if (this.offline || $('game').hidden) {
      bar.hidden = true;
      return;
    }
    if (net.room && !net.connected) {
      bar.hidden = false;
      bar.classList.add('is-mine');
      $('presenceTitle').textContent = t('Connection lost — your table is held');
      $('presenceText').textContent = t('Reconnecting {n}', { n: Math.max(1, this.lastNetStatus?.retry || 1) });
      $('presenceWaitBtn').hidden = true;
      $('presenceEndBtn').hidden = true;
      this.presenceWasMine = true;
      return;
    }
    const seat = this.suspendedSeat;
    if (!seat || !this.session.isPlaying) {
      bar.hidden = true;
      return;
    }
    const away = Date.now() >= this.holdUntil;
    bar.hidden = false;
    bar.classList.remove('is-mine');
    $('presenceTitle').textContent = away ? t('The opponent did not come back') : t('The opponent stepped away');
    $('presenceText').textContent = away
      ? t('The seat is still held — wait a little longer?')
      : t('Waiting for the return — {n}s', { n: Math.max(1, Math.ceil((this.holdUntil - Date.now()) / 1000)) });
    $('presenceWaitBtn').hidden = false;
    $('presenceWaitBtn').textContent = t('Wait 30 s more');
    $('presenceEndBtn').hidden = false;
    $('presenceEndBtn').textContent = t('End the game');
  }

  extendHold() {
    if (!this.suspendedSeat) return;
    const now = Date.now();
    this.holdUntil = Math.min(Math.max(this.holdUntil, now) + SUSPEND_HOLD_MS, now + SUSPEND_SEAT_MS);
    this.renderPresence();
  }

  endAbandonedGame() {
    if (this.offline || !this.session.isPlaying || !this.session.isHost) return;
    if (!this.session.abandonGame()) return;
    this.suspendedSeat = 0;
    this.holdUntil = 0;
    this.renderPresence();
  }

  saveResume(game, room) {
    if (this.offline || !room || !game || game.status !== 'playing') return;
    saveResumeHint({
      room: room.id || room.name,
      name: room.name,
      move: Math.floor(game.moves.length / 2) + 1,
      color: this.session.myColor || '',
      savedAt: Date.now(),
    });
  }

  offerResume() {
    const hint = this.resumeHint;
    this.resumeHint = null;
    if (!hint) return;
    const label = hint.name || t('Table');
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <button class="icon-btn icon-btn--small modal__close" id="resumeClose" aria-label="${t('Close')}"><svg><use href="#i-close"></use></svg></button>
      <p class="panel-kicker">${t('Unfinished game')}</p>
      <h2>${escapeHtml(label)}</h2>
      <p>${escapeHtml(t('Your table {name} is waiting — move {n}.', { name: label, n: hint.move || 1 }))}</p>
      <div class="modal__actions">
        <button class="btn btn--ghost btn--compact" id="resumeDrop" type="button">${t('New table')}</button>
        <button class="btn btn--gold btn--compact" id="resumeContinue" type="button">${t('Continue')}</button>
      </div>
    `;
    this.openModal(modal, { focus: modal.querySelector('#resumeContinue') });
    modal.querySelector('#resumeClose').addEventListener('click', () => this.closeModal());
    modal.querySelector('#resumeDrop').addEventListener('click', () => {
      this.closeModal();
      saveResumeHint(null);
      this.resumeRetried = false;
    });
    modal.querySelector('#resumeContinue').addEventListener('click', () => {
      this.closeModal();
      this.resumeTried = true;
      this.net.joinRoom(hint.room);
    });
  }

  /* --------------------------------------------------------------- toast */
  showToast(text, type = '') {
    if (!text) return;
    const root = $('toasts');
    while (root.children.length >= 4) root.firstElementChild?.remove();
    const toast = document.createElement('div');
    toast.className = `toast${type ? ` is-${type}` : ''}`;
    toast.textContent = text;
    root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    const ttl = type === 'error' ? 5200 : 3200;
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 350);
    }, ttl);
  }

  onResult(snapshot) {
    const game = snapshot.game;
    if (!game) return;
    saveResumeHint(null);
    this.scene.setCheck(null);
    this.scene.celebrate(game.winner);
    this.showTurnToast(this.resultTitle(game));
    if (snapshot.myColor && game.winner) {
      if (game.winner === snapshot.myColor) this.audio.win();
      else this.audio.lose();
    } else {
      this.audio.draw();
    }
    setTimeout(() => this.renderGame(), 50);
  }
}

const app = new SalonApp();
window.__ornate = app;
