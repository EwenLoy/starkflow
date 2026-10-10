# Плагин Construct 3

Установка аддона, минимальный пример и правила id. Полный список действий, условий и выражений — в
[ACE.md](ACE.md) (и в исходниках `plugin/aces.json`, `plugin/lang/en-US.json`), пошаговая сборка игры — в
[GAME-GUIDE.md](GAME-GUIDE.md).


1. Construct 3: меню, View, Addon Manager, Install new addon, выбери `dist/starkflow.c3addon`, перезапусти C3.
2. Добавь объект StarkFlow (single-global) в проект и впиши Server URL и App ID.
3. Пример для босса: при старте `Connect`, на `On connected` вызови `Join or create room "boss1"`. Удар: `Add -10 to state "boss_hp"`. Показывай `StarkFlow.State("boss_hp")`, обновляй на `On state "boss_hp" changed`.

## Список комнат: как читать

Список приходит массивом внутрь плагина, поэтому читается он индексом, а не объектом C3:

```
StarkFlow: On room list received
    → System: Repeat StarkFlow.RoomCount times
        → RoomRow: Create at (32, 120 + loopindex * 48)
        → RoomRow: Set instance variable roomId to StarkFlow.RoomIdAt(loopindex)
        → Text: Set text to StarkFlow.RoomNameAt(loopindex) & " " &
                      StarkFlow.RoomPlayersAt(loopindex) & "/" & StarkFlow.RoomMaxAt(loopindex) &
                      (StarkFlow.RoomLockedAt(loopindex) = 1 ? " 🔒" : "")

RoomRow: On clicked
    → StarkFlow: Join room with password (RoomRow.roomId, PasswordInput.Text)   // вход именно в эту комнату
```

`loopindex` — номер комнаты в списке (с нуля). Подробнее, включая «войти в первую свободную» и вариант с Array —
в [GAME-GUIDE.md](GAME-GUIDE.md#3-список-комнат-как-читать-и-как-перебирать).



1. Construct 3: меню, View, Addon Manager, Install new addon, выбери `dist/starkflow.c3addon`, перезапусти C3.
2. Добавь объект StarkFlow (single-global) в проект и впиши Server URL и App ID.
3. Пример для босса: при старте `Connect`, на `On connected` вызови `Join or create room "boss1"`. Удар: `Add -10 to state "boss_hp"`. Показывай `StarkFlow.State("boss_hp")`, обновляй на `On state "boss_hp" changed`.

Токен игрока плагин сам кладёт в `localStorage`. В worker-режиме C3 `localStorage` недоступен, тогда сохраняй `AuthToken` сам (например, в LocalStorage-плагин) и передавай в `Connect` или `SetAuthToken`.

Аддон зарегистрирован под уникальным id `EwenLoy_StarkFlow`. Он должен совпадать в трёх местах:
`plugin/addon.json` (`id`), `plugin/plugin.js` (константа `PLUGIN_ID`) и ключ языка в
`plugin/lang/en-US.json` (`text.plugins.ewenloy_starkflow`). Если делаешь форк — поменяй id на свой
(`ТвойНик_StarkFlow`), иначе C3 посчитает оба аддона одним и тем же.
