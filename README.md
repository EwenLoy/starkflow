# StarkFlow M0-M2: сервер на Go и плагин для Construct 3

Простой мультиплеер для игр на C3: **комнаты, события, общий стейт комнаты** (с атомарным `add`).

## Что проверено, а что нет

| Часть | Статус |
|---|---|
| Плагин (рантайм), 64 действия, условия и выражения | Проверен тестом на заглушке WebSocket (`node tests/plugin-mock-test.js`): подключение, комната, события, стейт, реконнект с автоматическим повторным входом, ошибки |
| Сверка `aces.json`, языкового файла и кода | Проверена скриптом: каждое ACE есть в коде с нужным числом параметров |
| Тестовая страница сервера | Скрипт проверен на синтаксис |
| **Сервер на Go** | Собран и прогнан на Go 1.26.1: `go mod tidy`, `go build ./...`, `go vet ./...`, `go test ./...` — без ошибок и правок; плюс живой smoke-тест `node tests/server-smoke.mjs` (42 проверки) против запущенного сервера — всё зелёное |
| **Загрузка плагина в Construct 3** | **Не проверялась**: формат файлов сверен с документацией Addon SDK v2, но в самом C3 его не запускали |

## Запуск сервера

Нужен Go 1.22 или новее.

```
cd server
go mod tidy          # скачает gorilla/websocket и создаст go.sum
go test ./...        # тесты стейта и токенов
go run ./cmd/starkflow
```

Открой http://localhost:8080: это встроенная тестовая страница. Открой её в двух вкладках, нажми Connect и «Join or create» в обеих, потом «Hit boss -10»: HP босса меняется у обоих. Кнопка «Try set boss_hp» должна вернуть ошибку 402.

Настройки через переменные окружения:

- `STARKFLOW_ADDR`: адрес, по умолчанию `:8080`
- `STARKFLOW_SECRET`: секрет подписи токенов игроков. Если не задан, при каждом запуске берётся случайный, и токены старых игроков перестают работать (плагин сам получит новый)
- `STARKFLOW_ORIGINS`: разрешённые Origin через запятую. Пусто = разрешено всё (только для разработки)

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
node tests/server-smoke.mjs                            # 42 проверки протокола
```

Он проверяет вручную то, что не покрыто unit-тестами: `welcome`, создание комнаты и `room.joined`,
`state.add` с рассылкой обоим игрокам, ошибки 100/102/200/300/303/400/402/403, зажим по `min`,
`toggle`, события `to: all/others`, `player.props`, `player.suspended` и повторный вход по токену,
`ping/pong`, `room.list` и изоляцию по `app`. Переменные `SF_BASE` и `SF_WS` переопределяют адрес.

## Игра с друзьями без домена

Из C3 на https-странице нужен `wss://`. Самое простое: туннель (например, Cloudflare Tunnel командой `cloudflared tunnel --url http://localhost:8080`, или ngrok), он выдаёт публичный адрес с https и wss. Условия бесплатных тарифов проверь на сайтах сервисов. В свойствах плагина укажи `wss://<адрес туннеля>/ws`.

## Плагин

1. Construct 3: меню, View, Addon Manager, Install new addon, выбери `starkflow.c3addon`, перезапусти C3.
2. Добавь объект StarkFlow (single-global) в проект и впиши Server URL и App ID.
3. Пример для босса: при старте `Connect`, на `On connected` вызови `Join or create room "boss1"`. Удар: `Add -10 to state "boss_hp"`. Показывай `StarkFlow.State("boss_hp")`, обновляй на `On state "boss_hp" changed`.

Токен игрока плагин сам кладёт в `localStorage`. В worker-режиме C3 `localStorage` недоступен, тогда сохраняй `AuthToken` сам (например, в LocalStorage-плагин) и передавай в `Connect` или `SetAuthToken`.

Перед публикацией замени в `plugin/addon.json` поля `id`, `author`, `website`, `documentation`: `id` должен быть уникальным среди всех аддонов C3 (например, `ТвойНик_StarkFlow`), и он должен совпадать в `plugin/plugin.js` (константа `PLUGIN_ID`).

## Протокол (кратко)

URL: `ws(s)://host/ws?v=1&app=APPID`. Все кадры JSON с полем `t`.

- Клиент: `hello`, `room.join`, `room.leave`, `room.list`, `event`, `state.set`, `state.add`, `state.toggle`, `player.set`, `ping`
- Сервер: `welcome`, `room.joined`, `player.joined`, `player.left`, `player.suspended`, `player.resumed`, `player.props`, `host.changed`, `event`, `state.changed`, `room.list.result`, `ok`, `err`, `pong`

Правила ключей стейта (`schema` при создании комнаты): `kind` (num, str, bool), `mode` (set, add, const, once, server), `min`, `max`, `maxDelta`, `reject`, `maxLen`.

## Отличия от плана в документе

- Возврат в комнату после обрыва идёт по подписанному `userId`, а не по отдельному `resumeKey`: токен уже подписан, второй ключ не нужен.
- Не сделано: режимы комнат locked и allowlist, шаблоны, админ-API, `appId` с отдельными секретами, `redirect` и Redis (это M5-M8). Задел есть: ключ комнаты уже `appId:имя`.
- `Shutdown` сервера пока не закрывает открытые WebSocket-соединения аккуратно.
