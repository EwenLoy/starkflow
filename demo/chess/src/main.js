import { ChessScene } from './scene.js';
import { StarkFlowClient } from './net.js';
import { ChessSession, START_FEN } from './session.js';
import { ChessAudio } from './audio.js';
import { findHint, openingName } from './engine.js';
import { pieceGlyph } from './pieces.js';

const CONFIG = {
  url: 'wss://starkflow.orkestr.run/ws',
  app: 'starkflow-chess',
  lobby: 'salon',
};

const $ = (id) => document.getElementById(id);
const ADJECTIVES = ['Изумрудный', 'Полночный', 'Золотой', 'Тихий', 'Королевский', 'Лазурный', 'Медный', 'Северный', 'Аметистовый', 'Серебряный'];
const NOUNS = ['гамбит', 'салон', 'этюд', 'ферзь', 'манёвр', 'эндшпиль', 'дебют', 'каприс', 'вернисаж', 'турнир'];
const PIECE_ORDER = ['q', 'r', 'b', 'n', 'p'];

function randomRoomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}

function randomGuestName() {
  return `Гость-${Math.floor(100 + Math.random() * 900)}`;
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
    this.name = cleanName(loadStored('ornate-chess:name', randomGuestName()));
    store('ornate-chess:name', this.name);
    this.nameInput = $('nameInput');
    this.roomInput = $('roomNameInput');
    this.nameInput.value = this.name;
    this.roomInput.value = randomRoomName();
    this.updateSeal();

    this.audio = new ChessAudio();
    this.net = new StarkFlowClient({ ...CONFIG, name: this.name });
    this.session = new ChessSession(this.net);
    this.scene = new ChessScene($('scene'), { onSquareClick: (square) => this.onSquareClick(square) });
    this.scene.setPosition(START_FEN, { initial: true });
    this.scene.setMode('lobby');

    this.directRoom = new URLSearchParams(location.search).get('room') || '';
    this.triedDirect = false;
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
    this.toastSeq = 0;
    this.offlineNotified = false;
    this.resultKey = '';
    this.suppressTurnToast = true;
    this.modalOpen = false;
    this.lastFocus = null;
    this.hintBusy = false;
    this.latency = null;

    this.bindUi();
    this.bindNet();
    this.bindSession();
    this.start();
  }

  /* ------------------------------------------------------------- startup */
  start() {
    this.refreshSoundButton();
    this.renderRooms();
    this.bumpBoot(18, 'Зажигаем свечи…');
    setTimeout(() => this.bumpBoot(38, 'Расставляем фигуры…'), 260);
    setTimeout(() => this.bumpBoot(58, 'Открываем двери салона…'), 520);
    setTimeout(() => this.bumpBoot(78, 'Ищем гостей за столами…'), 800);

    this.clockTimer = setInterval(() => this.updateClock(), 1000);
    this.listTimer = setInterval(() => {
      if (!this.net.room && document.visibilityState === 'visible' && this.net.connected) {
        this.net.listRooms();
      }
    }, 6000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.net.room && this.net.connected) this.net.listRooms();
    });

    this.net.connect(this.name).catch(() => {
      this.showToast('Сервер не ответил. Можно попробовать ещё раз.', 'error');
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
    this.bumpBoot(100, 'Добро пожаловать');
    const boot = $('boot');
    const app = $('app');
    app.classList.add('is-ready');
    app.setAttribute('aria-hidden', 'false');
    setTimeout(() => boot.classList.add('is-done'), 450);
  }

  /* --------------------------------------------------------------- net UI */
  bindNet() {
    this.net.on('status', (status) => this.updateStatus(status));
    this.net.on('welcome', () => {
      this.name = this.net.welcomeInfo.name || this.name;
      this.nameInput.value = this.name;
      this.updateSeal();
      this.renderRooms();
      if (this.directRoom && !this.triedDirect) {
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
      $('pingText').textContent = `${ms} мс`;
      $('latencyStat').textContent = `${ms} мс`;
    });
    this.net.on('room.joined', (detail) => {
      this.joining = false;
      this.pendingCreate = null;
      this.pendingCreateTries = 0;
      $('createBtn').disabled = false;
      this.enterGame(detail);
    });
    this.net.on('room.left', () => {
      this.enterLobby();
    });
    this.net.on('room.missing', () => {
      this.clearRoomQuery();
      this.enterLobby();
      this.showToast('Этот стол уже закрылся. Выберите другой.', 'error');
    });
    this.net.on('room.full', () => {
      this.joining = false;
      this.showToast('За этим столом больше нет мест.', 'error');
    });
    this.net.on('players.changed', (change) => {
      this.renderGame();
      if (change.joined && change.joined !== this.net.you) {
        const p = this.net.players.get(change.joined);
        this.showToast(`${p?.name || 'Гость'} подошёл к столу.`, 'ok');
      }
      if (change.left) {
        const p = change.player;
        if (p && p.id !== this.net.you) this.showToast(`${p.name || 'Игрок'} покинул стол.`);
      }
      if (change.suspended && change.suspended !== this.net.you) {
        this.showToast('У соперника пропала связь — место сохранено на 30 секунд.');
      }
      if (change.resumed && change.resumed !== this.net.you) {
        this.showToast('Соперник вернулся за стол.', 'ok');
      }
    });
    this.net.on('host.changed', () => {
      this.renderGame();
    });
    this.net.on('error', (err) => this.onNetError(err));
    this.net.on('game.event', (event) => {
      if (event.code === 90 && event.data?.text) {
        this.showToast(`${this.playerName(event.from)}: ${String(event.data.text).slice(0, 80)}`);
      }
    });
  }

  bindSession() {
    this.session.on('change', (snapshot) => {
      this.syncBoardFromSnapshot(snapshot);
      this.renderGame();
    });
    this.session.on('move', (data) => {
      if (data.fen === this.lastFen) {
        this.updateBoardMarkers();
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
    });
    this.session.on('turn', (turn) => {
      if (turn.inCheck) {
        this.showTurnToast(turn.mine ? 'Шах! Ваш ход' : 'Шах сопернику');
      } else if (turn.mine) {
        this.showTurnToast('Ваш ход');
      } else {
        this.showTurnToast(`Ход ${turn.color === 'w' ? 'белых' : 'чёрных'}`);
      }
      if (!this.suppressTurnToast) this.audio.turn();
      this.suppressTurnToast = false;
    });
    this.session.on('pending', () => {
      this.syncInteraction();
      this.showTurnToast('Ход отправлен…');
    });
    this.session.on('result', (snapshot) => {
      this.onResult(snapshot);
    });
    this.session.on('toast', ({ text, type }) => this.showToast(text, type));
    this.session.on('invalid-state', () => this.showToast('Состояние стола пришло повреждённым. Ждём обновления.', 'error'));
  }

  bindUi() {
    $('createBtn').addEventListener('click', () => this.createRoom());
    $('quickBtn').addEventListener('click', () => this.quickGame());
    $('refreshBtn').addEventListener('click', () => this.refreshRooms());
    $('nameInput').addEventListener('change', () => this.applyName());
    $('nameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.applyName();
      }
    });
    this.nameInput.addEventListener('input', () => this.updateSeal());
    this.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.createRoom();
      }
    });
    $('soundBtn').addEventListener('click', () => {
      const on = this.audio.toggle();
      this.refreshSoundButton();
      this.showToast(on ? 'Звук включён' : 'Звук выключен');
    });
    $('helpBtn').addEventListener('click', () => this.openHelp());
    $('howBtn').addEventListener('click', () => this.openHelp());
    $('fullscreenBtn').addEventListener('click', () => this.toggleFullscreen());
    $('netPill').addEventListener('click', () => {
      if (!this.net.connected) this.net.manualRetry();
    });
    $('leaveBtn').addEventListener('click', () => this.confirmLeave());
    $('brandBtn').addEventListener('click', () => {
      if (this.net.room) this.confirmLeave();
    });
    $('copyBtn').addEventListener('click', () => this.copyInvite());
    $('inviteBtn').addEventListener('click', () => this.copyInvite());
    $('resetCameraBtn').addEventListener('click', () => this.scene.resetCamera());
    $('flipBtn').addEventListener('click', () => this.scene.flipView());
    $('hintBtn').addEventListener('click', () => this.giveHint());
    $('drawBtn').addEventListener('click', () => this.askDraw());
    $('resignBtn').addEventListener('click', () => this.confirmResign());
    $('acceptDrawBtn').addEventListener('click', () => {
      this.session.acceptDraw();
      this.showToast('Ничья принята.', 'ok');
    });
    $('declineDrawBtn').addEventListener('click', () => {
      this.session.declineDraw();
      this.showToast('Ничья отклонена.');
    });
    $('rematchBtn').addEventListener('click', () => this.rematch());
    $('resultRematchBtn').addEventListener('click', () => this.rematch());
    $('resultLobbyBtn').addEventListener('click', () => this.confirmLeave());
    $('modalRoot').addEventListener('click', (e) => {
      if (e.target === $('modalRoot') || e.target.classList.contains('modal-backdrop')) this.closeModal();
    });
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('online', () => {
      if (!this.net.connected) this.net.manualRetry();
    });
    window.addEventListener('beforeunload', () => {
      if (this.net.room) this.net.request('room.leave');
    });
  }

  /* --------------------------------------------------------- connection */
  updateStatus(status) {
    const pill = $('netPill');
    const text = $('netText');
    pill.classList.remove('is-online', 'is-connecting', 'is-offline');
    if (status.state === 'online') {
      pill.classList.add('is-online');
      text.textContent = 'В сети';
      this.offlineNotified = false;
    } else if (status.state === 'retrying') {
      pill.classList.add('is-connecting');
      text.textContent = `Переподключение ${status.retry}`;
    } else if (status.state === 'exhausted') {
      pill.classList.add('is-offline');
      text.textContent = 'Нет связи';
      this.showToast('Не удалось переподключиться. Нажмите на индикатор сети.', 'error');
    } else if (status.state === 'offline' || status.state === 'error') {
      pill.classList.add('is-offline');
      text.textContent = 'Нет связи';
      if (!this.offlineNotified) {
        this.offlineNotified = true;
        if (this.net.room) this.showToast('Связь потеряна. Возвращаемся за стол автоматически…');
      }
    } else if (status.state === 'reauth') {
      pill.classList.add('is-connecting');
      text.textContent = 'Обновляем вход';
    } else {
      pill.classList.add('is-connecting');
      text.textContent = status.state === 'hello' ? 'Входим…' : 'Соединение…';
    }
    $('pingText').textContent = this.net.latency != null ? `${this.net.latency} мс` : '';
    this.syncInteraction();
    if (status.state === 'online') this.renderRooms();
  }

  onNetError({ code, msg }) {
    const messages = {
      100: 'Несовместимая версия протокола.',
      101: 'Сервер не понял сообщение.',
      102: 'Сначала нужно войти в сеть.',
      200: 'Сессия устарела — входим заново.',
      300: 'Стол не найден.',
      301: 'За столом нет свободных мест.',
      302: 'Этот стол уже закрыт.',
      303: 'Вы уже сидите за столом.',
      305: 'Вы не за столом.',
      306: 'Слишком короткое или странное имя стола.',
      307: 'Неверный пароль стола.',
      308: 'Стол с таким именем уже существует.',
      400: 'Неизвестный ключ состояния.',
      401: 'Конфликт типов в состоянии стола.',
      500: 'Слишком много сообщений. Попробуйте ещё раз.',
      501: 'Сообщение слишком большое.',
      502: 'Сервер занят.',
    };
    if (code === 308 && this.pendingCreate && this.pendingCreateTries < 2) {
      this.pendingCreateTries += 1;
      const next = randomRoomName();
      this.roomInput.value = next;
      this.pendingCreate = next;
      this.net.createRoom(next, { maxPlayers: 8, emptyTTL: 300 });
      this.showToast('Имя занято — открываем соседний стол.', 'ok');
      return;
    }
    if (code === 303) return;
    this.joining = false;
    $('createBtn').disabled = false;
    this.showToast(messages[code] || `Ошибка сервера ${code}: ${msg || ''}`.trim(), 'error');
    if (code === 500) this.showToast('Лимит отправки: подождите секунду.', 'error');
  }

  /* ------------------------------------------------------------- identity */
  updateSeal() {
    const raw = this.nameInput.value.trim() || 'Г';
    $('playerInitial').textContent = [...raw][0]?.toUpperCase() || 'Г';
  }

  async applyName() {
    const value = cleanName(this.nameInput.value);
    this.name = value;
    this.nameInput.value = value;
    store('ornate-chess:name', value);
    this.updateSeal();
    if (this.net.room) return;
    if (!this.net.connected) {
      if (this.net.active) await this.net.connect(value).catch(() => {});
      return;
    }
    if (this.net.welcomeInfo?.name === value) return;
    try {
      await this.net.rename(value);
      this.showToast('Имя обновлено.', 'ok');
    } catch {
      this.showToast('Не удалось обновить имя.', 'error');
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
  renderRooms() {
    const list = $('roomList');
    const rooms = this.roomList;
    $('tableCount').textContent = String(rooms.length);
    const players = rooms.reduce((sum, room) => sum + (Number(room.players) || 0), 0);
    $('onlineCount').textContent = String(players);
    $('latencyStat').textContent = this.latency != null ? `${this.latency} мс` : '—';

    list.innerHTML = '';
    if (!rooms.length) {
      const empty = document.createElement('div');
      empty.className = 'room-empty';
      empty.innerHTML = `
        <span class="room-empty__sigil">♞</span>
        <strong>Пока тихо</strong>
        <span>Откройте первый стол — и он появится здесь. Ссылку можно сразу отправить другу.</span>
      `;
      list.appendChild(empty);
      return;
    }

    const label = document.createElement('div');
    label.className = 'room-list__label';
    label.innerHTML = `<span>${rooms.length} ${rooms.length === 1 ? 'стол' : rooms.length < 5 ? 'стола' : 'столов'}</span><span>нажмите, чтобы войти</span>`;
    list.appendChild(label);

    for (const room of rooms) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'room-card';
      const count = Number(room.players) || 0;
      const max = Number(room.maxPlayers) || 8;
      const full = count >= max;
      const badgeClass = full ? 'room-card__badge room-card__badge--full' : count === 1 ? 'room-card__badge room-card__badge--live' : 'room-card__badge';
      const badgeText = full ? 'полон' : count === 1 ? 'ждёт гостя' : `${count} игрока`;
      card.innerHTML = `
        <span class="room-card__sigil">${count === 1 ? '♛' : count >= 3 ? '♜' : '♞'}</span>
        <span class="room-card__text">
          <strong class="room-card__name">${escapeHtml(room.room || 'Без имени')}</strong>
          <span class="room-card__meta"><span>#${escapeHtml(String(room.id || '').slice(0, 6))}</span><i></i><span>${count} / ${max}</span>${room.locked ? '<i></i><span>закрыт</span>' : ''}</span>
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
      this.showToast('Дайте столу имя подлиннее.', 'error');
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
      this.net.createRoom(room, { maxPlayers: 8, emptyTTL: 300 });
    } catch {
      this.joining = false;
      this.pendingCreate = null;
      $('createBtn').disabled = false;
      $('quickBtn').disabled = false;
      this.showToast('Не удалось связаться с сервером.', 'error');
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
    this.roomInput.value = randomRoomName();
    this.createRoom(this.roomInput.value);
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
      this.showToast('Не удалось связаться с сервером.', 'error');
    }
  }

  enterGame(detail) {
    this.suppressTurnToast = true;
    this.lastViewColor = null;
    this.hasRenderedBoard = false;
    this.lastFen = '';
    this.selected = null;
    this.legal = [];
    this.resultKey = '';
    $('lobby').hidden = true;
    $('game').hidden = false;
    document.body.classList.add('in-game');
    const room = detail.room;
    $('roomTitle').textContent = room.name;
    $('roomKicker').textContent = `Стол #${room.id}`;
    $('inviteCode').textContent = room.id || '————————';
    this.scene.setMode('game');
    this.scene.clearSelection();
    const url = new URL(location.href);
    url.searchParams.set('room', room.id || room.name);
    history.replaceState(null, '', url);
    this.renderGame();
    if (this.session.game) this.syncBoardFromSnapshot(this.session.snapshot());
    if (detail.resumed) this.showToast('Вы вернулись за свой стол.', 'ok');
    else if (detail.created) this.showToast('Стол открыт. Пригласите друга по ссылке.', 'ok');
    else this.showToast('Вы за столом.', 'ok');
  }

  enterLobby() {
    this.clearRoomQuery();
    $('game').hidden = true;
    $('lobby').hidden = false;
    document.body.classList.remove('in-game');
    this.hasRenderedBoard = false;
    this.lastFen = '';
    this.selected = null;
    this.legal = [];
    this.closeResult();
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
    if (!game || !this.net.room) return;
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

  renderGame() {
    if ($('game').hidden) return;
    const game = this.session.game;
    const room = this.net.room;
    if (!room) return;

    if (!game) {
      $('statusTitle').textContent = 'Хозяин готовит стол';
      $('statusText').textContent = 'Через мгновение здесь появится партия.';
      $('phaseLabel').textContent = 'Стол';
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
    $('inviteStrip').hidden = !!game.blackId && game.status === 'playing';
    $('spectatorBadge').hidden = !this.session.isSpectator;
    $('spectatorHint').hidden = !(this.session.isSpectator && game.blackId && game.whiteId);
    $('moveCount').textContent = `${Math.ceil(game.moves.length / 2)} ${plural(Math.ceil(game.moves.length / 2), 'ход', 'хода', 'ходов')}`;
    $('openingName').textContent = openingName(game.moves);
    this.updateClock();

    $('drawBtn').disabled = !this.session.isPlaying || !!game.drawOffer || this.session.pending;
    $('resignBtn').disabled = !this.session.isPlaying;
    $('hintBtn').disabled = !this.session.isPlaying || this.session.pending;
    $('rematchBtn').hidden = game.status === 'playing' || game.status === 'waiting';
    $('rematchBtn').disabled = !this.session.isHost;
    $('resultRematchBtn').disabled = !this.session.isHost;
    $('resultRematchBtn').textContent = this.session.isHost ? 'Реванш' : 'Реванш у хоста';
    $('resultRematchBtn').title = this.session.isHost ? 'Начать новую партию' : 'Новую партию начинает хозяин стола';

    this.syncInteraction();
  }

  renderPlayerCard(side, player, color, turn) {
    const prefix = side;
    const card = $(`${prefix}Card`);
    const name = $(`${prefix}Name`);
    const meta = $(`${prefix}Meta`);
    const avatar = $(`${prefix}Avatar`);
    const turnPill = $(`${prefix}Turn`);
    const isMe = player && player.id === this.net.you;
    const active = player && player.status !== 'suspended' && player.status !== 'gone';
    card.classList.toggle('is-you', !!isMe);
    card.classList.toggle('is-turn', turn === color);
    turnPill.textContent = turn === color ? 'ход' : '';
    avatar.textContent = color === 'w' ? '♔' : '♚';
    if (!player) {
      name.textContent = 'Свободное место';
      meta.textContent = color === 'b' ? 'ждём гостя · можно позвать' : 'место хозяина';
      card.classList.remove('is-you');
      this.fillCaptures(side, []);
      return;
    }
    name.textContent = player.name || `Игрок #${player.id}`;
    if (!active) meta.textContent = 'отключился · место сохранено';
    else if (player.id === this.net.hostId) meta.textContent = `хозяин стола · #${player.id}`;
    else meta.textContent = `гость · #${player.id}`;
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
      list.innerHTML = '<li class="move-list__empty">Первый ход ещё впереди.</li>';
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
    const me = this.playerName(this.net.you);

    if (game.status === 'waiting' || !game.blackId) {
      phase.textContent = 'Стол открыт';
      title.textContent = 'Ожидание соперника';
      text.textContent = 'Ссылка на стол уже готова. Отправьте её другу — и партия начнётся.';
      pill.textContent = 'ожидание';
      pill.className = 'turn-pill';
      return;
    }

    if (game.status === 'playing') {
      phase.textContent = 'Партия идёт';
      const turnName = turn === 'w' ? 'белых' : 'чёрных';
      const opponent = turn === myColor ? null : this.playerName(turn === 'w' ? game.whiteId : game.blackId);
      if (myColor && turn === myColor) {
        title.textContent = this.session.inCheck ? 'Шах — ваш ход' : 'Ваш ход';
        text.textContent = 'Выберите фигуру на доске, затем поле. Подсвеченные точки — допустимые ходы.';
        pill.textContent = 'ваш ход';
        pill.className = 'turn-pill is-mine';
      } else if (myColor) {
        title.textContent = `${opponent || 'Соперник'} думает`;
        text.textContent = this.session.inCheck ? 'Соперник под шахом. Следите за ответом.' : 'Ход за соперником. Можно изучить позицию или предложить ничью.';
        pill.textContent = `ход ${turnName}`;
        pill.className = 'turn-pill';
      } else {
        title.textContent = 'Партия идёт';
        text.textContent = `${this.playerName(game.whiteId)} против ${this.playerName(game.blackId)}. Вы наблюдаете за столом.`;
        pill.textContent = `ход ${turnName}`;
        pill.className = 'turn-pill';
      }
      return;
    }

    phase.textContent = 'Партия завершена';
    pill.textContent = 'итог';
    pill.className = 'turn-pill';
    title.textContent = this.resultTitle(game);
    text.textContent = this.resultDescription(game, white, black);
    if (myColor && game.winner === myColor) text.textContent += ' Поздравляем — это ваша победа.';
  }

  resultTitle(game) {
    switch (game.status) {
      case 'checkmate': return 'Мат';
      case 'resigned': return 'Сдача';
      case 'abandoned': return 'Стол опустел';
      case 'stalemate': return 'Пат';
      case 'draw': return 'Ничья';
      default: return 'Партия завершена';
    }
  }

  resultDescription(game, white, black) {
    const winnerName = game.winner ? this.playerName(game.winner === 'w' ? game.whiteId : game.blackId) : null;
    if (game.status === 'checkmate') return `Мат. ${winnerName || (game.winner === 'w' ? 'Белые' : 'Чёрные')} забирают партию.`;
    if (game.status === 'resigned') return `${winnerName || 'Соперник'} победил сдачей противника.`;
    if (game.status === 'abandoned') return `${winnerName || 'Соперник'} остался за столом и забирает партию.`;
    if (game.status === 'stalemate') return 'Король не под шахом, но допустимых ходов нет. Пат.';
    const reasons = {
      agreement: 'Соперники согласились на ничью.',
      material: 'На доске недостаточно материала для мата.',
      repetition: 'Позиция повторилась трижды.',
      fifty: 'Правило пятидесяти ходов.',
      draw: 'Партия завершилась вничью.',
    };
    return reasons[game.reason] || 'Партия завершилась вничью.';
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
    $('resultKicker').textContent = game.status === 'draw' || game.status === 'stalemate' ? 'Ничья' : 'Партия завершена';
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
      $('drawOfferText').textContent = `${this.playerName(game.drawOffer)} предлагает ничью.`;
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
  }

  playerName(id) {
    if (!id) return 'Соперник';
    if (id === this.net.you) return this.net.welcomeInfo?.name || this.name;
    const player = this.net.players.get(id);
    return player?.name || `Игрок #${id}`;
  }

  showTurnToast(text) {
    const el = $('turnToast');
    $('turnToastText').textContent = text;
    el.classList.add('is-visible');
    clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => el.classList.remove('is-visible'), 2200);
  }

  syncInteraction() {
    const allowed = !!this.net.room && this.net.connected && this.session.isPlaying && !this.session.pending && !this.modalOpen;
    this.scene.setInteractive(allowed);
    this.syncSelectionVisual();
  }

  syncSelectionVisual() {
    if (!this.selected) {
      this.scene.clearSelection();
      return;
    }
    const legal = this.session.legalMoves(this.selected);
    if (!legal.length || !this.session.canMoveFrom(this.selected)) {
      this.selected = null;
      this.legal = [];
      this.scene.clearSelection();
      return;
    }
    this.legal = legal;
    this.scene.selectSquare(this.selected, legal);
  }

  /* ------------------------------------------------------------- actions */
  onSquareClick(square) {
    if (!square || this.modalOpen || !this.net.connected || !this.net.room) return;
    if (!this.session.isPlaying || this.session.pending) return;

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
    if (!this.session.canMoveFrom(square)) {
      this.scene.clearSelection();
      return;
    }
    const piece = this.session.chess.get(square);
    if (!piece || piece.color !== this.session.myColor) return;
    this.selected = square;
    this.legal = this.session.legalMoves(square);
    this.scene.selectSquare(square, this.legal);
    this.audio.select();
  }

  commitMove(from, to, promotion) {
    const result = this.session.tryMove(from, to, promotion);
    this.selected = null;
    this.legal = [];
    this.scene.clearSelection();
    if (result === 'not-your-turn') this.showToast('Сейчас не ваш ход.', 'error');
    else if (result === 'pending') this.showToast('Предыдущий ход ещё подтверждается.');
    else if (result === 'not-playing') this.showToast('Партия сейчас не идёт.', 'error');
    else if (result === 'illegal') this.showToast('Так ходить нельзя.', 'error');
    else if (result === 'promotion') this.showToast('Выберите фигуру для превращения.');
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
      <button class="icon-btn icon-btn--small modal__close" id="promoClose" aria-label="Закрыть"><svg><use href="#i-close"></use></svg></button>
      <p class="panel-kicker">Превращение</p>
      <h2>Выберите фигуру</h2>
      <p>Пешка дошла до последней горизонтали. Кем она станет?</p>
      <div class="promo-grid" id="promoGrid"></div>
    `;
    const grid = modal.querySelector('#promoGrid');
    for (const type of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'promo-btn';
      btn.innerHTML = `<span>${pieceGlyph(type, color)}</span><small>${{ q: 'Ферзь', r: 'Ладья', b: 'Слон', n: 'Конь' }[type]}</small>`;
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
    if (this.session.game?.drawOffer === this.net.you) {
      this.showToast('Предложение уже отправлено.');
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
      kicker: 'Сдаться',
      title: 'Сложить оружие?',
      text: 'Партия сразу завершится победой соперника. Ваш рейтинг в салоне не пострадает — здесь играют за удовольствие.',
      confirm: 'Сдаться',
      danger: true,
      onConfirm: () => {
        this.session.resign();
        this.closeModal();
      },
    });
  }

  rematch() {
    if (!this.session.isHost) {
      this.showToast('Новую партию начинает хозяин стола.', 'error');
      return;
    }
    if (this.session.game?.status === 'playing') return;
    if (this.session.newGame()) {
      this.closeResult();
      this.showToast('Новая партия! Фигуры уже расставлены.', 'ok');
    }
  }

  confirmLeave() {
    if (!this.net.room) return;
    if (this.session.isPlaying) {
      this.confirm({
        kicker: 'Покинуть стол',
        title: 'Оставить партию?',
        text: 'Вы выйдете в лобби, а соперник получит победу по оставленному столу. Вернуться можно будет по ссылке, но партия уже завершится.',
        confirm: 'Выйти в лобби',
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
        this.showToast('Подсказка не нашлась — позиция уже решена.');
        return;
      }
      this.scene.setHint(hint);
      this.showToast(`Подсказка: ${hint.san}`, 'ok');
      this.audio.select();
    }, 30);
  }

  async copyInvite() {
    const room = this.net.room;
    if (!room) return;
    const link = roomUrl(room.id || room.name);
    const ok = await copyText(link);
    this.showToast(ok ? 'Ссылка на стол скопирована.' : link, ok ? 'ok' : 'error');
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
    if (e.key === 'm' || e.key === 'M') {
      const on = this.audio.toggle();
      this.refreshSoundButton();
      this.showToast(on ? 'Звук включён' : 'Звук выключен');
    }
    if (e.key === '?') this.openHelp();
  }

  refreshSoundButton() {
    const btn = $('soundBtn');
    btn.classList.toggle('is-muted', !this.audio.enabled);
    btn.setAttribute('aria-label', this.audio.enabled ? 'Выключить звук' : 'Включить звук');
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

  confirm({ kicker = 'Подтверждение', title, text, confirm = 'Подтвердить', danger = false, onConfirm }) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <button class="icon-btn icon-btn--small modal__close" id="confirmClose" aria-label="Закрыть"><svg><use href="#i-close"></use></svg></button>
      <p class="panel-kicker">${escapeHtml(kicker)}</p>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(text)}</p>
      <div class="modal__actions">
        <button class="btn btn--ghost btn--compact" id="confirmCancel" type="button">Отмена</button>
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
      <button class="icon-btn icon-btn--small modal__close" id="helpClose" aria-label="Закрыть"><svg><use href="#i-close"></use></svg></button>
      <p class="panel-kicker">Ornate · 3D Chess Salon</p>
      <h2>Как играть</h2>
      <p>Выберите стол в гостиной или откройте свой. Первый гость играет белыми, второй — чёрными, остальные наблюдают.</p>
      <div class="help-grid">
        <div class="help-item"><span class="help-item__icon">♟</span><div><strong>Ход</strong><p>Нажмите на свою фигуру, затем на подсвеченное поле. Точки — свободные поля, кольца — взятия.</p></div></div>
        <div class="help-item"><span class="help-item__icon">♜</span><div><strong>Камера</strong><p>Вращайте доску мышью, приближайте колесом. «Перевернуть» меняет сторону, «Камера» возвращает парадный вид.</p></div></div>
        <div class="help-item"><span class="help-item__icon">♞</span><div><strong>Соперник</strong><p>Пришлите другу ссылку на стол. Он попадёт сразу в партию. Для двух игроков на одном компьютере удобнее приватное окно или второй профиль браузера.</p></div></div>
        <div class="help-item"><span class="help-item__icon">♛</span><div><strong>Честность</strong><p>Сервер передаёт позицию и ходы, а проверка правил идёт на клиенте. Это дружеский салон, а не турнир с античитом.</p></div></div>
        <div class="help-item"><span class="help-item__icon">✦</span><div><strong>Клавиши</strong><p><b>R</b> — камера, <b>F</b> — переворот, <b>M</b> — звук, <b>Esc</b> — закрыть окно.</p></div></div>
      </div>
      <div class="modal__actions">
        <button class="btn btn--gold btn--compact" id="helpOk" type="button">Понятно</button>
      </div>
      <p style="margin:18px 0 0;font-size:9px;color:var(--muted-2)">StarkFlow WebSocket · Three.js · без регистрации и установки</p>
    `;
    modal.querySelector('#helpClose').addEventListener('click', () => this.closeModal());
    modal.querySelector('#helpOk').addEventListener('click', () => this.closeModal());
    this.openModal(modal, { focus: modal.querySelector('#helpOk') });
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

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

const app = new SalonApp();
window.__ornate = app;
