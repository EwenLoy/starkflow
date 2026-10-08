# StarkFlow — multiplayer for Construct 3 games on your own server

[![CI](https://github.com/EwenLoy/starkflow/actions/workflows/ci.yml/badge.svg)](https://github.com/EwenLoy/starkflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Donate](https://img.shields.io/badge/donate-dalink.to%2Fewenloy-ff69b4.svg)](https://dalink.to/ewenloy)

**EN** — StarkFlow adds multiplayer to Construct 3 games without a backend service: you run one Go binary
on your own machine or VPS, and players connect straight to it over WebSocket.

- **Rooms** have a short id and a display name in **any language** (length limit is configurable, 32 characters by
  default). Duplicate names are allowed — the id is what identifies a room.
- **Shared room state** with atomic `add` and per-key rules (`mode`, `min`/`max`, `maxDelta`, `reject`) —
  the server clamps or rejects, and never trusts the client.
- **Signed player tokens** (HMAC-SHA256, nothing stored on the server): after a connection drop the player returns
  to the same room with the same id and the same state.
- **Relay events** (to all / others / one player), **per-player state** (cursor positions, ready flags, colours),
  host tracking, players kept as *suspended* for 30 s.
- **Test client** built into the server binary: open http://localhost:8080. Two demo modes: boss fight
  (shared HP with `add` rules) and cursor synchronisation (per-player state + events).
- **Construct 3 plugin** `EwenLoy_StarkFlow`: 14 actions, 20 conditions, 30 expressions — install
  `dist/starkflow.c3addon` via C3 → View → Addon Manager. Full ACE list: `plugin/aces.json`.

Quick start:

```
cd server
go mod tidy
go test ./...
go run ./cmd/starkflow     # test client at http://localhost:8080
```

Tests: `go test ./...` (room state, tokens), `node tests/plugin-mock-test.js` (every ACE exists in the runtime
with the right arity + plugin behaviour on a WebSocket stub), `node tests/server-smoke.mjs` (54 live protocol
checks against a running server). Minimum: Go 1.22+, Node 22+ for the JS tests.

Protocol summary in English: rooms are created with `room.join {create:true}` (always a new room), joined with
`room.join {room:"<id-or-name>", create:false}`; the server answers with `welcome`, `room.joined`, `state.changed`,
`player.*`, `event`, `err`. Client messages: `hello`, `room.join`, `room.leave`, `room.list`, `event`,
`state.set/add/toggle`, `player.set`, `ping`. Details: `server/internal/proto/proto.go` and the Russian section below.

**MIT licensed** — use it for anything, including commercial games, no strings attached, just keep the copyright
notice (see [LICENSE](LICENSE)). If StarkFlow saves you time, you can
[support development](https://dalink.to/ewenloy) — completely optional and it changes nothing about the license.

---

# StarkFlow M0-M2: сервер на Go и плагин для Construct 3

Простой мультиплеер для игр на C3: **комнаты, события, общий стейт комнаты** (с атомарным `add`).

## Что проверено, а что нет

| Часть | Статус |
|---|---|
| Плагин (рантайм), 64 ACE (14 действий, 20 условий, 30 выражений) | Проверен тестом на заглушке WebSocket (`node tests/plugin-mock-test.js`): подключение, комната, события, стейт, реконнект с автоматическим повторным входом, ошибки |
| Сверка `aces.json`, языкового файла и кода | Проверена скриптом: каждое ACE есть в коде с нужным числом параметров |
| Тестовая страница сервера | Проверена в реальном браузере (headless Chrome через DevTools Protocol): 40 проверок отрисовки курсоров, настроек частоты и сглаживания |
| **Сервер на Go** | Собран и прогнан на Go 1.26.1: `go mod tidy`, `go build ./...`, `go vet ./...`, `go test ./...` — без ошибок и правок; плюс живой smoke-тест `node tests/server-smoke.mjs` (54 проверки) против запущенного сервера — всё зелёное |
| **Загрузка плагина в Construct 3** | **Не проверялась**: формат файлов сверен с документацией Addon SDK v2, но в самом C3 его не запускали |

## Запуск сервера

Нужен Go 1.22 или новее.

```
cd server
go mod tidy          # скачает gorilla/websocket и создаст go.sum
go test ./...        # тесты стейта и токенов
go run ./cmd/starkflow
```

Открой http://localhost:8080 — это встроенный тестовый клиент:

1. **Подключение**: впиши имя, нажми «Подключиться» (адрес и App ID подставляются автоматически). Справа видны вы, ваш токен и статус; там же кнопки «Отключиться», «Забыть токен» и галка авто-возврата в комнату после обрыва.
2. **Комнаты**: после подключения подгружается список комнат вашего App ID — у каждой видно имя и `#id`. «Войти» подключает к выбранной комнате (по id), «Войти в случайную» — к любой свободной. Имя комнаты теперь просто метка: **любой язык, до 32 символов** (лимит задаёт сервер и присылает в `welcome`), а каждая кнопка «Создать комнату» создаёт **новую** комнату со своим id — одинаковые имена разрешены. Режим:
   - **Бой с боссом** — общий HP: «Ударить −10» любого игрока меняет его у всех (HP-бар), «Попытка set boss_hp» должна вернуть ошибку 402;
   - **Синхронизация курсоров** — веди мышь по полю: остальные видят твой курсор с ником и цветом, клик по полю даёт у остальных вспышку (это событие). Режим хранится в стейте комнаты ключом `mode`, поэтому вошедший в существующую комнату подхватывает его автоматически. Сами позиции идут **стейтом игрока** (`player.set "cursor"`), а не общим стейтом комнаты: перезаписать чужой курсор нельзя, ключи не тратят лимит комнаты, а вышедший игрок уносит свой курсор с собой — призраков не остаётся.
   - В режиме курсоров две независимые настройки, обе запоминаются в `localStorage`:
     - **«Частота отправки позиции»** — 1–60 кадров/с (по умолчанию 20) — сколько кадров уходит в сеть. 60 — это ровно потолок сервера (60 сообщений/с на соединение); интервал отправки округляется вверх (17 мс вместо 16.67 мс), поэтому фактически получается ~58 кадров/с, зато без ошибок 500. Отправка идёт фиксированным тактом, так что заданная частота соблюдается точно (проверено: 10 → 12 кадров за 1.2 с, 20 → 24, 40 → 48, 60 → 70).
     - **«Сглаживание чужого курсора»** — 0–500 мс вручную, либо галка «авто от частоты» (авто = 1.4 × интервал отправки, зажато в 70…300 мс). `0` — сглаживания нет, чужой курсор двигается рывками с частотой отправки; больше миллисекунд — плавнее, но с задержкой. Частота отвечает за трафик, сглаживание — за вид.
3. Для игры вдвоём открой страницу **во втором браузере или в приватном окне**: вкладки одного браузера делят токен в `localStorage` и играют за одного игрока (сервер считает это возвратом того же игрока и закрывает старое соединение).

Страница вшита в бинарник сервера (`//go:embed web/index.html`), поэтому после её правки сервер надо перезапустить: иначе он продолжит отдавать старую версию, и в браузере будет не то, что лежит в `server/internal/server/web/index.html`.

Настройки через переменные окружения:

- `STARKFLOW_ADDR`: адрес, по умолчанию `:8080`
- `STARKFLOW_SECRET`: секрет подписи токенов игроков. Если не задан, при каждом запуске берётся случайный, и токены старых игроков перестают работать (плагин сам получит новый)
- `STARKFLOW_ORIGINS`: разрешённые Origin через запятую. Пусто = разрешено всё (только для разработки)
- `STARKFLOW_ROOM_NAME_MAX`: максимальная длина названия комнаты в символах (любой язык, включая эмодзи), по умолчанию `32`. Лимит приходит клиенту в `welcome`

Остальные лимиты лежат в `server/internal/config/config.go`.

## Тесты

```
cd server && go test ./...          # unit-тесты: стейт (лимиты, режимы ключей) и токены
node tests/plugin-mock-test.js      # плагин: сверка ACE и поведение на заглушке WebSocket
```

Живой end-to-end тест против запущенного сервера (нужен Node 22+ со встроенным `WebSocket`):

```
cd server && go build -o starkflow.exe ./cmd/starkflow
$env:STARKFLOW_SECRET='devsecret'; ./starkflow.exe    # отдельное окно
node tests/server-smoke.mjs                            # 54 проверки протокола
```

Он проверяет вручную то, что не покрыто unit-тестами: `welcome`, создание комнаты и `room.joined`,
`state.add` с рассылкой обоим игрокам, ошибки 100/102/200/300/303/400/402/403, зажим по `min`,
`toggle`, события `to: all/others`, `player.props`, `player.suspended` и повторный вход по токену,
`ping/pong`, `room.list` и изоляцию по `app`. Переменные `SF_BASE` и `SF_WS` переопределяют адрес.

## Игра с друзьями без домена

Из C3 на https-странице нужен `wss://`. Самое простое: туннель (например, Cloudflare Tunnel командой `cloudflared tunnel --url http://localhost:8080`, или ngrok), он выдаёт публичный адрес с https и wss. Условия бесплатных тарифов проверь на сайтах сервисов. В свойствах плагина укажи `wss://<адрес туннеля>/ws`.

## Плагин

1. Construct 3: меню, View, Addon Manager, Install new addon, выбери `dist/starkflow.c3addon`, перезапусти C3.
2. Добавь объект StarkFlow (single-global) в проект и впиши Server URL и App ID.
3. Пример для босса: при старте `Connect`, на `On connected` вызови `Join or create room "boss1"`. Удар: `Add -10 to state "boss_hp"`. Показывай `StarkFlow.State("boss_hp")`, обновляй на `On state "boss_hp" changed`.

Токен игрока плагин сам кладёт в `localStorage`. В worker-режиме C3 `localStorage` недоступен, тогда сохраняй `AuthToken` сам (например, в LocalStorage-плагин) и передавай в `Connect` или `SetAuthToken`.

Аддон зарегистрирован под уникальным id `EwenLoy_StarkFlow`. Он должен совпадать в трёх местах:
`plugin/addon.json` (`id`), `plugin/plugin.js` (константа `PLUGIN_ID`) и ключ языка в
`plugin/lang/en-US.json` (`text.plugins.ewenloy_starkflow`). Если делаешь форк — поменяй id на свой
(`ТвойНик_StarkFlow`), иначе C3 посчитает оба аддона одним и тем же.

## Протокол (кратко)

URL: `ws(s)://host/ws?v=1&app=APPID`. Все кадры JSON с полем `t`.

Комната живёт по **id** (8 hex-символов, генерирует сервер), а имя — просто метка для людей:
в `room.join` поле `room` — это либо id, либо имя; `create: true` **всегда** создаёт новую комнату
(одинаковые имена разрешены), `create: false` ищет сначала по id, потом по имени (самую старую
комнату с таким именем). `room.joined` отдаёт `roomId`, `room.list` — массив `{id, room, players, maxPlayers}`,
`welcome` — `roomNameMax`. Имена пишутся на любом языке; управляющие символы вырезаются, длина считается
в символах (не в байтах).

- Клиент: `hello`, `room.join`, `room.leave`, `room.list`, `event`, `state.set`, `state.add`, `state.toggle`, `player.set`, `ping`
- Сервер: `welcome`, `room.joined`, `player.joined`, `player.left`, `player.suspended`, `player.resumed`, `player.props`, `host.changed`, `event`, `state.changed`, `room.list.result`, `ok`, `err`, `pong`

Правила ключей стейта (`schema` при создании комнаты): `kind` (num, str, bool), `mode` (set, add, const, once, server), `min`, `max`, `maxDelta`, `reject`, `maxLen`.

Два разных хранилища, не путать:
- `state.set/add/toggle` — **общий стейт комнаты** (ключи + правила из `schema`): писать может любой игрок в комнате, `state.changed` рассылается всем, включая автора, лимит — 20 записей/с на игрока, 64 ключа и 64 КБ на комнату. Сюда идут `boss_hp` и маркер режима `mode`.
- `player.set` — **стейт игрока** (`player.props`): писать может только сам игрок, значение приходит как `player.props`, а вошедшему — внутри `players[].props` в `room.joined`. До 16 ключей на игрока, правил ключей нет, отдельного лимита на частоту нет (только общий лимит 60 сообщений/с на соединение). Здесь лежат позиции курсоров.

## Отличия от плана в документе

- Возврат в комнату после обрыва идёт по подписанному `userId`, а не по отдельному `resumeKey`: токен уже подписан, второй ключ не нужен.
- Не сделано: режимы комнат locked и allowlist, шаблоны, админ-API, `appId` с отдельными секретами, `redirect` и Redis (это M5-M8). Задел есть: ключ комнаты уже `appId:имя`.
- `Shutdown` сервера пока не закрывает открытые WebSocket-соединения аккуратно.

## Лицензия

MIT — можно всё: личные и коммерческие проекты, правки, встраивание, продажа продуктов на его основе.
Единственное условие — сохранить текст лицензии и копирайт. Полный текст: [LICENSE](LICENSE).

## Поддержать проект

Проект бесплатный и open source. Если он сэкономил тебе время — можно отправить донат:
**https://dalink.to/ewenloy**

Это добровольно и никак не влияет ни на лицензию, ни на приоритет поддержки: issues и pull request'ы
принимаются одинаково от всех. Кнопка поддержки также есть в шапке репозитория (`.github/FUNDING.yml`).
