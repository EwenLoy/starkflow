# Протокол StarkFlow

Схема сообщений в коде: `server/internal/proto/proto.go`. Ниже то, что нужно знать для игры.



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

