const STORAGE_KEY = 'ornate-chess:lang';
const DEFAULT_LOCALE = 'en';

const ru = {
  // Boot
  'Polishing pieces and lighting candles…': 'Полируем фигуры и зажигаем свечи…',
  'Lighting the candles…': 'Зажигаем свечи…',
  'Setting the pieces…': 'Расставляем фигуры…',
  'Opening the salon doors…': 'Открываем двери салона…',
  'Looking for guests at the tables…': 'Ищем гостей за столами…',
  'Welcome': 'Добро пожаловать',

  // Top bar
  'Back to lobby': 'Вернуться в лобби',
  'Three-dimensional chess board': 'Трёхмерная шахматная доска',
  'Connection status': 'Состояние соединения',
  'Connecting…': 'Соединение…',
  'Mute sound': 'Выключить звук',
  'Unmute sound': 'Включить звук',
  'Sound': 'Звук',
  'Rules and tips': 'Правила и подсказки',
  'Help': 'Помощь',
  'Fullscreen': 'Полный экран',
  'Switch to Russian': 'Переключить на русский',
  'Switch to English': 'Переключить на английский',

  // Network
  'Online': 'В сети',
  'Reconnecting {n}': 'Переподключение {n}',
  'No connection': 'Нет связи',
  'Refreshing session': 'Обновляем вход',
  'Signing in…': 'Входим…',
  'Connecting': 'Соединение…',
  'Could not reconnect. Tap the network indicator.': 'Не удалось переподключиться. Нажмите на индикатор сети.',
  'Connection lost. Rejoining the table automatically…': 'Связь потеряна. Возвращаемся за стол автоматически…',
  'Server did not respond. Try again.': 'Сервер не ответил. Можно попробовать ещё раз.',

  // Lobby
  'Online salon · StarkFlow': 'Онлайн-салон · StarkFlow',
  'Royal<br /><em>salon</em>': 'Королевский<br /><em>салон</em>',
  'Chess that makes you want to stay. A living table of dark stone and brass, sculptural pieces, and an opponent on the other side of the network.':
    'Шахматы, в которых хочется задержаться. Живой стол из тёмного камня и латуни, скульптурные фигуры и соперник по ту сторону сети.',
  'Quick game': 'Быстрая партия',
  'Play vs bot': 'Играть с ботом',
  'Offline salon': 'Оффлайн-салон',
  'No network, no waiting. Pick an opponent and a side.': 'Без сети и ожидания. Выберите соперника и сторону.',
  'Novice': 'Новичок',
  'Club player': 'Клубный игрок',
  'Maestro': 'Маэстро',
  'A relaxed opponent. Sees one move ahead.': 'Спокойный соперник. Считает на один ход вперёд.',
  'A steady opponent. Looks two moves ahead.': 'Уверенный соперник. Считает на два хода вперёд.',
  'Deep calculation, captures and a short endgame search.': 'Глубокий расчёт, размены и короткий поиск в эндшпиле.',
  '1 move': '1 ход',
  '2 moves': '2 хода',
  '4 moves': '4 хода',
  'Your side': 'Ваша сторона',
  'Random': 'Случайно',
  'Start game': 'Начать партию',
  'Offline game': 'Оффлайн-партия',
  'Bot · {level}': 'Бот · {level}',
  'Your turn': 'Ваш ход',
  'Leave the game?': 'Покинуть партию?',
  'The offline game will be lost. You can start a new one from the lobby at any time.': 'Оффлайн-партия будет потеряна. Новую можно начать из лобби в любой момент.',
  'How to play': 'Как играть',
  'guests in the salon': 'гостей в зале',
  'tables open': 'столов открыто',
  'network latency': 'задержка сети',
  'Two-player game · spectators can take a seat': 'Партия на двоих · зрители могут занять место за столом',
  'Lounge': 'Гостиная',
  'Open tables': 'Открытые столы',
  'Refresh tables': 'Обновить список столов',
  'Refresh': 'Обновить',
  'Your name': 'Ваше имя',
  'New table': 'Новый стол',
  'Create': 'Создать',
  'Copy the table link and send it to a friend — they will land straight in the game.':
    'Скопируйте ссылку на стол и отправьте другу — он попадёт сразу в партию.',
  'No tables yet': 'Пока тихо',
  'Open the first table — it will appear here. You can send the link to a friend right away.':
    'Откройте первый стол — и он появится здесь. Ссылку можно сразу отправить другу.',
  '{n} table': '{n} стол',
  '{n} tables': '{n} столов',
  'tap to join': 'нажмите, чтобы войти',
  'full': 'полон',
  'waiting for guest': 'ждёт гостя',
  '{n} players': '{n} игрока',
  'No name': 'Без имени',
  'locked': 'закрыт',
  'Give the table a longer name.': 'Дайте столу имя подлиннее.',
  'Could not reach the server.': 'Не удалось связаться с сервером.',
  'This table has already closed. Choose another.': 'Этот стол уже закрылся. Выберите другой.',
  'There are no seats left at this table.': 'За этим столом больше нет мест.',
  '{name} joined the table.': '{name} подошёл к столу.',
  '{name} left the table.': '{name} покинул стол.',
  'Opponent lost connection — the seat is held for 30 seconds.': 'У соперника пропала связь — место сохранено на 30 секунд.',
  'Opponent is back at the table.': 'Соперник вернулся за стол.',
  'Name already taken — opening a neighbouring table.': 'Имя занято — открываем соседний стол.',
  'Server error {code}: {msg}': 'Ошибка сервера {code}: {msg}',
  'Rate limit: wait a second.': 'Лимит отправки: подождите секунду.',
  'Name updated.': 'Имя обновлено.',
  'Could not update the name.': 'Не удалось обновить имя.',

  // Game shell
  'Table': 'Стол',
  'Chess salon': 'Шахматный салон',
  'Copy table link': 'Скопировать ссылку на стол',
  'Invite a friend': 'Пригласить друга',
  'Reset camera': 'Сбросить камеру',
  'Black': 'Чёрные',
  'White': 'Белые',
  'Waiting for opponent': 'Ждём соперника',
  'seat available': 'место свободно',
  'Table host': 'Хозяин стола',
  'opening the game': 'создаёт партию',
  'move': 'ход',
  'Game moves': 'Ход партии',
  'Match': 'Партия',
  'The table is ready. Invite a friend by link.': 'Стол создан. Пригласите друга по ссылке.',
  'Opening ahead': 'Дебют впереди',
  'Table code': 'Код стола',
  'Copy': 'Копировать',
  'Moves': 'Ходы',
  '0 moves': '0 ходов',
  'you are watching': 'вы наблюдаете',
  'The first move is still ahead.': 'Первый ход ещё впереди.',
  'Draw': 'Ничья',
  'Resign': 'Сдаться',
  'New game': 'Новая партия',
  'Flip': 'Перевернуть',
  'Hint': 'Подсказка',
  'Opponent offers a draw.': 'Соперник предлагает ничью.',
  'Accept': 'Принять',
  'Decline': 'Отклонить',
  'Game over': 'Партия завершена',
  'Checkmate': 'Мат',
  'White wins the game.': 'Белые выиграли партию.',
  'Rematch': 'Реванш',
  'Back to tables': 'К столам',
  'You are watching. A seat will open up — and you can take it.':
    'Вы в зале как зритель. Место освободится — и вы сможете сесть за стол.',
  'made with love for the game': 'с любовью к игре',

  // Game status
  '{color} to move': 'Ход {color}',
  'White to move': 'Ход белых',
  'Black to move': 'Ход чёрных',
  'Check! Your move': 'Шах! Ваш ход',
  'Check on the opponent': 'Шах сопернику',
  'Your move': 'Ваш ход',
  'Wait for your turn': 'Дождитесь своего хода',
  'You are watching': 'Вы наблюдаете',
  'Move sent…': 'Ход отправлен…',
  'The table state arrived corrupted. Waiting for an update.': 'Состояние стола пришло повреждённым. Ждём обновления.',
  'The host is preparing the table': 'Хозяин готовит стол',
  'The game will appear here in a moment.': 'Через мгновение здесь появится партия.',
  'Table open': 'Стол открыт',
  'The link is ready. Send it to a friend and the game will begin.': 'Ссылка на стол уже готова. Отправьте её другу — и партия начнётся.',
  'waiting': 'ожидание',
  'Game in progress': 'Партия идёт',
  'Check — your move': 'Шах — ваш ход',
  'Choose a piece on the board, then a square. Highlighted dots are legal moves.':
    'Выберите фигуру на доске, затем поле. Подсвеченные точки — допустимые ходы.',
  'your move': 'ваш ход',
  '{name} is thinking': '{name} думает',
  'Opponent is in check. Watch their reply.': 'Соперник под шахом. Следите за ответом.',
  "Opponent's turn. Study the position or offer a draw.": 'Ход за соперником. Можно изучить позицию или предложить ничью.',
  '{white} vs {black}. You are watching the table.': '{white} против {black}. Вы наблюдаете за столом.',
  'result': 'итог',
  'Congratulations — that is your win.': 'Поздравляем — это ваша победа.',
  'Free seat': 'Свободное место',
  'waiting for a guest · feel free to invite': 'ждём гостя · можно позвать',
  "host's seat": 'место хозяина',
  'Player #{id}': 'Игрок #{id}',
  'disconnected · seat held': 'отключился · место сохранено',
  'table host · #{id}': 'хозяин стола · #{id}',
  'guest · #{id}': 'гость · #{id}',
  'Host rematch': 'Реванш у хоста',
  'Start a new game': 'Начать новую партию',
  'The host starts the next game': 'Новую партию начинает хозяин стола',
  '{name} offers a draw.': '{name} предлагает ничью.',

  // Results
  'Resignation': 'Сдача',
  'Table abandoned': 'Стол опустел',
  'Stalemate': 'Пат',
  'Checkmate. {winner} takes the game.': 'Мат. {winner} забирает партию.',
  '{winner} wins by resignation.': '{winner} победил сдачей противника.',
  '{winner} remains at the table and takes the game.': '{winner} остался за столом и забирает партию.',
  'The king is not in check, but there are no legal moves. Stalemate.':
    'Король не под шахом, но допустимых ходов нет. Пат.',
  'The opponents agreed to a draw.': 'Соперники согласились на ничью.',
  'There is not enough material on the board for checkmate.': 'На доске недостаточно материала для мата.',
  'The position repeated three times.': 'Позиция повторилась трижды.',
  'The fifty-move rule.': 'Правило пятидесяти ходов.',
  'The game ended in a draw.': 'Партия завершилась вничью.',
  'The game is over.': 'Партия завершена.',

  // Errors / actions
  'Incompatible protocol version.': 'Несовместимая версия протокола.',
  'The server did not understand the message.': 'Сервер не понял сообщение.',
  'Sign in first.': 'Сначала нужно войти в сеть.',
  'The session expired — signing in again.': 'Сессия устарела — входим заново.',
  'Table not found.': 'Стол не найден.',
  'No seats left at the table.': 'За столом нет свободных мест.',
  'This table is closed.': 'Этот стол уже закрыт.',
  'You are already at a table.': 'Вы уже сидите за столом.',
  'You are not at a table.': 'Вы не за столом.',
  'The table name is too short or invalid.': 'Слишком короткое или странное имя стола.',
  'Wrong table password.': 'Неверный пароль стола.',
  'A table with that name already exists.': 'Стол с таким именем уже существует.',
  'Unknown state key.': 'Неизвестный ключ состояния.',
  'Type conflict in the table state.': 'Конфликт типов в состоянии стола.',
  'Too many messages. Try again.': 'Слишком много сообщений. Попробуйте ещё раз.',
  'The message is too large.': 'Сообщение слишком большое.',
  'The server is busy.': 'Сервер занят.',
  'Sound on': 'Звук включён',
  'Sound off': 'Звук выключен',
  'Draw accepted.': 'Ничья принята.',
  'Draw declined.': 'Ничья отклонена.',
  'It is not your turn.': 'Сейчас не ваш ход.',
  'The previous move is still being confirmed.': 'Предыдущий ход ещё подтверждается.',
  'The game is not running.': 'Партия сейчас не идёт.',
  'That move is not legal.': 'Так ходить нельзя.',
  'Choose a promotion piece.': 'Выберите фигуру для превращения.',
  'Draw offer already sent.': 'Предложение уже отправлено.',
  'Only the host can start a new game.': 'Новую партию начинает хозяин стола.',
  'New game! The pieces are ready.': 'Новая партия! Фигуры уже расставлены.',
  'No hint found — the position is already decided.': 'Подсказка не нашлась — позиция уже решена.',
  'Hint: {san}': 'Подсказка: {san}',
  'Table link copied.': 'Ссылка на стол скопирована.',
  'Language switched to English': 'Язык переключён на английский',
  'Language switched to Russian': 'Язык переключён на русский',
  'Guest-{n}': 'Гость-{n}',

  // Promotion
  'Promotion': 'Превращение',
  'Choose a piece': 'Выберите фигуру',
  'The pawn reached the last rank. What will it become?': 'Пешка дошла до последней горизонтали. Кем она станет?',
  'Queen': 'Ферзь',
  'Rook': 'Ладья',
  'Bishop': 'Слон',
  'Knight': 'Конь',
  'Close': 'Закрыть',

  // Confirm
  'Confirmation': 'Подтверждение',
  'Confirm': 'Подтвердить',
  'Cancel': 'Отмена',
  'Resign the game?': 'Сложить оружие?',
  'The game ends immediately with a win for your opponent. Your salon rating is not affected — people play here for pleasure.':
    'Партия сразу завершится победой соперника. Ваш рейтинг в салоне не пострадает — здесь играют за удовольствие.',
  'Leave the table?': 'Оставить партию?',
  'You will return to the lobby and your opponent gets the win. You can come back by link, but the game will already be over.':
    'Вы выйдете в лобби, а соперник получит победу по оставленному столу. Вернуться можно будет по ссылке, но партия уже завершится.',
  'Leave to lobby': 'Выйти в лобби',
  'Leave table': 'Покинуть стол',

  // Help
  'How to play': 'Как играть',
  'Choose a table in the lounge or open your own. The first guest plays White, the second plays Black, everyone else watches.':
    'Выберите стол в гостиной или откройте свой. Первый гость играет белыми, второй — чёрными, остальные наблюдают.',
  'Move': 'Ход',
  'Click your piece, then a highlighted square. Dots are empty squares, rings are captures.':
    'Нажмите на свою фигуру, затем на подсвеченное поле. Точки — свободные поля, кольца — взятия.',
  'Camera': 'Камера',
  'Rotate the board with the mouse and zoom with the wheel. “Flip” changes sides, “Camera” returns to the ceremonial view.':
    'Вращайте доску мышью, приближайте колесом. «Перевернуть» меняет сторону, «Камера» возвращает парадный вид.',
  'Opponent': 'Соперник',
  'Send a friend the table link. They will land straight in the game. For two players on one computer, a private window or a second browser profile is best.':
    'Пришлите другу ссылку на стол. Он попадёт сразу в партию. Для двух игроков на одном компьютере удобнее приватное окно или второй профиль браузера.',
  'Fair play': 'Честность',
  'The server relays the position and moves, while the rules are checked on the client. This is a friendly salon, not an anti-cheat tournament.':
    'Сервер передаёт позицию и ходы, а проверка правил идёт на клиенте. Это дружеский салон, а не турнир с античитом.',
  'Keys': 'Клавиши',
  '<b>R</b> — camera, <b>F</b> — flip, <b>M</b> — sound, <b>Esc</b> — close a window.':
    '<b>R</b> — камера, <b>F</b> — переворот, <b>M</b> — звук, <b>Esc</b> — закрыть окно.',
  'Got it': 'Понятно',
  'StarkFlow WebSocket · Three.js · no sign-up or installation': 'StarkFlow WebSocket · Three.js · без регистрации и установки',

  // Meta
  'Ornate · 3D Chess Salon': 'Ornate · 3D шахматный салон',
  'Ornate Chess Salon — cinematic 3D online chess with a room list. StarkFlow WebSocket, Three.js.':
    'Ornate Chess Salon — кинематографичные 3D-шахматы онлайн со списком столов. StarkFlow WebSocket, Three.js.',
  'You are back at your table.': 'Вы вернулись за свой стол.',
  'Table is open. Invite a friend by link.': 'Стол открыт. Пригласите друга по ссылке.',
  'You are at the table.': 'Вы за столом.',
  'Guest': 'Гость',
  'Spectator': 'Зритель',
  'Disconnected': 'Отключился',
  'The server did not confirm the move. Check your connection.': 'Сервер не подтвердил ход. Проверьте соединение.',
  'Draw offer sent.': 'Предложение ничьей отправлено.',
  'you': 'вы',
};

const dictionaries = { en: {}, ru };
const listeners = new Set();
let locale = readLocale();

function readLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    /* private mode */
  }
  return DEFAULT_LOCALE;
}

export function getLocale() {
  return locale;
}

export function t(key, vars = {}) {
  const template = dictionaries[locale]?.[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? `{${name}}`));
}

export function hasTranslation(key) {
  return Object.prototype.hasOwnProperty.call(dictionaries.ru, key);
}

export function setLocale(next) {
  const value = next === 'ru' ? 'ru' : 'en';
  if (value === locale) return value;
  locale = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* private mode */
  }
  document.documentElement.lang = value;
  document.title = t('Ornate · 3D Chess Salon');
  const meta = document.querySelector('meta[name="description"]');
  if (meta) meta.setAttribute('content', t('Ornate Chess Salon — cinematic 3D online chess with a room list. StarkFlow WebSocket, Three.js.'));
  applyTranslations(document);
  for (const fn of listeners) {
    try {
      fn(value);
    } catch (err) {
      console.error('[i18n] listener failed', err);
    }
  }
  return value;
}

export function toggleLocale() {
  return setLocale(locale === 'en' ? 'ru' : 'en');
}

export function onLocale(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyTranslations(root = document) {
  document.documentElement.lang = locale;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  }
}

export function isRussian() {
  return locale === 'ru';
}

export function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
