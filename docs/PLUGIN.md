# Плагин Construct 3

Установка аддона, минимальный пример и правила id. Полный список действий, условий и выражений — в
`plugin/aces.json` и `plugin/lang/en-US.json`.


1. Construct 3: меню, View, Addon Manager, Install new addon, выбери `dist/starkflow.c3addon`, перезапусти C3.
2. Добавь объект StarkFlow (single-global) в проект и впиши Server URL и App ID.
3. Пример для босса: при старте `Connect`, на `On connected` вызови `Join or create room "boss1"`. Удар: `Add -10 to state "boss_hp"`. Показывай `StarkFlow.State("boss_hp")`, обновляй на `On state "boss_hp" changed`.

Токен игрока плагин сам кладёт в `localStorage`. В worker-режиме C3 `localStorage` недоступен, тогда сохраняй `AuthToken` сам (например, в LocalStorage-плагин) и передавай в `Connect` или `SetAuthToken`.

Аддон зарегистрирован под уникальным id `EwenLoy_StarkFlow`. Он должен совпадать в трёх местах:
`plugin/addon.json` (`id`), `plugin/plugin.js` (константа `PLUGIN_ID`) и ключ языка в
`plugin/lang/en-US.json` (`text.plugins.ewenloy_starkflow`). Если делаешь форк — поменяй id на свой
(`ТвойНик_StarkFlow`), иначе C3 посчитает оба аддона одним и тем же.
