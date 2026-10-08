# StarkFlow

Мультиплеер для игр на Construct 3 на своём сервере: комнаты, события, общий стейт комнаты. Один Go-бинарник,
без внешних сервисов, регистраций и подписок.

**Русский** · [English](README.md)

[![CI](https://github.com/EwenLoy/starkflow/actions/workflows/ci.yml/badge.svg)](https://github.com/EwenLoy/starkflow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Donate](https://img.shields.io/badge/donate-dalink.to%2Fewenloy-ff69b4.svg)](https://dalink.to/ewenloy)

## Что это

- **Комнаты** — короткий id плюс имя на любом языке (по умолчанию до 32 символов), одинаковые имена разрешены.
- **Общий стейт комнаты** с правилами ключей: `add` атомарный, `min`/`max`/`maxDelta` зажимает сервер.
- **События** — всем, остальным или одному игроку.
- **Стейт игрока** — курсоры, флаги, цвет: пишет только сам игрок, чужие значения не подделать.
- **Токены игроков** (подписанные, на сервере ничего не хранится): после обрыва игрок возвращается в ту же комнату.
- **В комплекте** встроенный тестовый клиент и плагин для Construct 3.

## Быстрый старт

Нужен Go 1.22+. Настраивать ничего не надо:

```bash
cd server
go run ./cmd/starkflow
```

Открой http://localhost:8080 — это тестовый клиент сервера с двумя режимами: бой с боссом (общий HP) и
синхронизация курсоров. Чтобы поиграть вдвоём, открой ту же страницу во втором браузере или в приватном окне.

## Быстрый тест с другом за пару минут (Docker)

```bash
git clone https://github.com/EwenLoy/starkflow.git && cd starkflow
docker compose up -d --build
```

Дальше ничего не нужно: сервер сам слушает `0.0.0.0` на порту 8080, сам поднимается после перезапуска машины,
у контейнера есть healthcheck (`docker compose ps` показывает `healthy`). Открыть в панели сервера надо только
порт 8080. Друг заходит на `http://<IP-сервера>:8080` и играет.

Если публичного IP нет или не хочется открывать порты — тот же compose-файл даёт временный адрес с https:

```bash
docker compose --profile tunnel up -d
docker compose logs tunnel | grep trycloudflare    # получишь адрес вида https://xxxx.trycloudflare.com
```

## Свой домен и https

Домен ставится одной командой: Caddy сам получит и продлит сертификат Let's Encrypt и сам проксирует
WebSocket, вручную настраивать нечего.

```bash
cp .env.example .env     # впиши STARKFLOW_SECRET и SF_DOMAIN, например game.example.com
docker compose -f docker-compose.tls.yml --profile caddy up -d --build
```

Остаётся направить A-запись домена на IP сервера. Адрес для плагина C3 получается `wss://game.example.com/ws`.

Если порты 80/443 открыть нельзя (или домен живёт на Cloudflare) — второй профиль в том же файле поднимает
туннель Cloudflare с твоим токеном, DNS-запись создастся сама. Оба варианта описаны в шапке
`docker-compose.tls.yml`.

## Требования

| Что | Зачем |
|---|---|
| Go 1.22+ | запустить сервер без Docker |
| Docker + Compose | деплой на сервер (рекомендуемый путь) |
| Node 22+ | только для тестов из `tests/` |
| Construct 3 | аддон `dist/starkflow.c3addon` (в самом C3 пока не проверялся) |

## Тесты

```bash
cd server && go test ./...       # стейт комнаты и токены
node tests/plugin-mock-test.js   # плагин: 64 ACE и поведение на заглушке WebSocket
node tests/server-smoke.mjs      # 54 проверки протокола против запущенного сервера
```

Всё это работает в CI на каждый push: 4 задачи (сервер, плагин, живой smoke-тест, сборка Docker-образа).

## Технические детали

| Файл / папка | Что внутри |
|---|---|
| `server/` | сервер на Go: комнаты, стейт, токены, встроенная тестовая страница (`internal/server/web/`) |
| `plugin/` | исходники аддона C3: `addon.json`, `c3runtime/`, ACE, языковые файлы |
| `dist/starkflow.c3addon` | собранный аддон: C3 → View → Addon Manager → Install new addon |
| `Dockerfile`, `docker-compose.yml` | контейнер и запуск на сервере (плюс профиль туннеля) |
| `docker-compose.tls.yml`, `Caddyfile` | https на своём домене: Caddy или туннель Cloudflare |
| `tests/` | тесты: unit-тесты Go, проверка ACE, живой smoke-тест протокола |
| `docs/` | подробная документация |

Документация:

- [docs/DEPLOY.md](docs/DEPLOY.md) — деплой: VPS, свой домен и https, туннели, хостинг ботов, переменные окружения
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — протокол: сообщения, комнаты, правила ключей стейта, два хранилища
- [docs/PLUGIN.md](docs/PLUGIN.md) — установка плагина и первый пример в C3
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — локальный запуск, тестовый клиент, тесты, CI, что проверено и что нет

## Лицензия и поддержка

MIT: можно всё, включая коммерческие игры, условие одно — сохранить текст [LICENSE](LICENSE) и копирайт.
Если проект сэкономил тебе время, можно [поддержать разработку](https://dalink.to/ewenloy) — это добровольно и
никак не влияет ни на лицензию, ни на приоритет ответов в issues.
