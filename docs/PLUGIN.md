# Плагин Construct 3

Установка аддона, минимальный пример и правила id. Полный список действий, условий и выражений — в
[ACE.md](ACE.md) (и в исходниках `plugin/aces.json`, `plugin/lang/en-US.json`), пошаговая сборка игры — в
[GAME-GUIDE.md](GAME-GUIDE.md). Все документы — в [README.md](README.md).

## Установка

1. Construct 3: меню → **View** → **Addon Manager** → **Install new addon**, выбери `dist/starkflow.c3addon`,
   перезапусти C3.
2. Добавь объект StarkFlow (single-global) в проект и впиши Server URL и App ID.

> [!WARNING]
> Объект StarkFlow должен быть **Global** (или лежать на отдельном layout): иначе он создастся заново при смене
> layout и соединение порвётся. После пересборки аддона его надо переустановить — C3 кэширует старую версию.

## Минимальный пример

При старте — `Connect`, на `On connected` — `Join or create room "boss1"`. Удар по боссу — `Add -10 to state
"boss_hp"`. Показывай `StarkFlow.State("boss_hp")` и обновляй текст на `On state "boss_hp" changed`:

```text
On start of layout
    → StarkFlow: Connect ("", "")

StarkFlow: On connected
    → StarkFlow: Join or create room ("boss1", 8, 300)

Player: On key "Space" pressed
    → StarkFlow: Add to state ("boss_hp", -10)

StarkFlow: On state "boss_hp" changed
    → BossHpText: Set text StarkFlow.State("boss_hp")
```

## Список комнат: как читать

Список приходит массивом внутрь плагина, поэтому читается он индексом, а не объектом C3:

```text
StarkFlow: On room list received
    → System: Repeat StarkFlow.RoomCount times
        → RoomRow: Create at (32, 120 + loopindex * 48)
        → RoomRow: Set instance variable roomId to StarkFlow.RoomIdAt(loopindex)
        → Text: Set text to StarkFlow.RoomNameAt(loopindex) & " " &
                      StarkFlow.RoomPlayersAt(loopindex) & "/" & StarkFlow.RoomMaxAt(loopindex) &
                      (StarkFlow.RoomLockedAt(loopindex) = 1 ? " 🔒" : "")

RoomRow: On clicked
    → StarkFlow: Join room (RoomRow.roomId, PasswordInput.Text)   // вход именно в эту комнату
```

`loopindex` — номер комнаты в списке (с нуля). Подробнее, включая «войти в первую свободную» и вариант с Array —
в [GAME-GUIDE.md](GAME-GUIDE.md#3-список-комнат-как-читать-и-как-перебирать).

## Inspector: что видно в отладчике

Запусти отладочный предпросмотр (**Preview → Debug layout** на тулбаре или клавишей F7), открой панель **Inspector**
и выбери объект StarkFlow — появятся секции с живыми значениями, обновляются сами. Ничего в проекте для этого
добавлять не нужно (в релизной сборке метод не вызывается вовсе).

| Секция | Что показывает |
|---|---|
| `StarkFlow - Connection` | Server URL, Connect URL (с `v` и `app`), App ID, Connection mode, Region, Status, Connected, Reconnect attempt, Auto reconnect, Ping (ms), Send rate (per s), Log level |
| `StarkFlow - Player` | My user id (постоянный, `MyUserId`), My player id in room, My name in room, Name to use, Token (маскированный), Player props sent, Props waiting, Server time offset (ms) |
| `StarkFlow - Room` | Room name, Room id, Players `сколько / максимум`, Host id (постоянный `userId`), Host index in room (номер в комнате), Am I host, Created by me, Resumed, Join target |
| `StarkFlow - Sync` | Synced objects, Proxies, Sync channel, WebRTC sync, Batch, Batch window (ms), Sync now, Smoothing (ms), Buffer delay (ms), Buffer size, Jitter (ms) |
| `StarkFlow - Last` | Error code, Error message, Event code / from / data, Changed key / value / by |
| `StarkFlow - Players` | строка на игрока: `#3 Duke` → `userId 9f2c… · host · active` |

`StarkFlow - Players` — самый быстрый способ проверить, что клиенты видят друг друга одинаково: у всех игроков в
комнате должны быть те же `userId`, что и `PlayerUserId(id)`, и на нём же должен быть подключён голосовой аддон.

> [!NOTE]
> Имена свойств начинаются с `$` намеренно: так отладчик C3 показывает строку как есть и не ищет её в файлах языка.

## Токен игрока

Токен плагин сам кладёт в `localStorage`. В worker-режиме C3 `localStorage` недоступен, тогда сохраняй
`AuthToken` сам (например, в LocalStorage-плагин) и передавай в `Connect` или `SetAuthToken`.

## id аддона

Аддон зарегистрирован под уникальным id `EwenLoy_StarkFlow`. Он должен совпадать в трёх местах:
`plugin/addon.json` (`id`), `plugin/plugin.js` (константа `PLUGIN_ID`) и ключ языка в
`plugin/lang/en-US.json` (`text.plugins.ewenloy_starkflow`).

> [!NOTE]
> Если делаешь форк — поменяй id на свой (`ТвойНик_StarkFlow`), иначе C3 посчитает оба аддона одним и тем же.

---

[← Все документы](README.md) · [GAME-GUIDE.md](GAME-GUIDE.md) · [ACE.md](ACE.md)
