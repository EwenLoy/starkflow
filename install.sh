#!/usr/bin/env bash
# Установщик StarkFlow на VPS: ставит Docker, спрашивает режим и домен,
# выпускает сертификат через Caddy (или Cloudflare Tunnel) и поднимает сервер.
#
#   bash install.sh                                        интерактивное меню
#   bash install.sh --domain game.example.com --yes         домен + https, без вопросов
#   bash install.sh --no-domain --yes                       только http://IP:8080
#   bash install.sh --mode directory --domain dir.example.com --yes
#   bash install.sh --token eyJhIjoi... --domain game.example.com --yes
#   bash install.sh --status | --logs | --update | --down
#
# Флаги: --domain D  --no-domain  --mode node|directory  --rtc-port N  --rtc-ip IP
#        --token T  --dir PATH  --port N  --yes  --help

set -uo pipefail

REPO_URL="${STARKFLOW_REPO_URL:-https://github.com/EwenLoy/starkflow.git}"
DEFAULT_DIR="/opt/starkflow"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

C_RESET=$'\033[0m'
C_GREEN=$'\033[1;32m'
C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m'
C_GRAY=$'\033[0;90m'
C_BOLD=$'\033[1;37m'

ACTION="install"
ORIG_ARGS=()
MODE="node"
DOMAIN=""
ACCESS=""
TOKEN="${CF_TUNNEL_TOKEN:-}"
RTC_PORT=""
RTC_IP=""
APP_DIR=""
HTTP_PORT="8080"
ASSUME_YES=0

say() { printf '%s\n' "$*"; }
ok() { printf '%s\n' "${C_GREEN}[ok]${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}[!]${C_RESET} $*"; }
err() { printf '%s\n' "${C_RED}[x]${C_RESET} $*" >&2; }
die() { err "$*"; exit 1; }
hr() { printf '%s\n' "${C_GRAY}──────────────────────────────────────────────────────────${C_RESET}"; }
title() { printf '\n%s\n' "${C_BOLD}$*${C_RESET}"; }

have_tty() {
	if [ -t 0 ]; then
		return 0
	fi
	( exec 3</dev/tty ) 2>/dev/null
}

tty_read() {
	if [ -t 0 ]; then
		read -r "$@"
	elif ( exec 3</dev/tty ) 2>/dev/null; then
		read -r "$@" </dev/tty
	else
		return 1
	fi
}

ask() {
	local prompt="$1" default="${2:-}" answer=""
	if [ -n "$default" ]; then
		printf '%s [%s]: ' "$prompt" "$default" >&2
	else
		printf '%s: ' "$prompt" >&2
	fi
	tty_read answer || answer=""
	answer="${answer#"${answer%%[![:space:]]*}"}"
	answer="${answer%"${answer##*[![:space:]]}"}"
	printf '%s' "${answer:-$default}"
}

ask_yn() {
	local prompt="$1" default="${2:-n}" answer="" hint="y/N"
	[ "$default" = "y" ] && hint="Y/n"
	while :; do
		printf '%s [%s]: ' "$prompt" "$hint" >&2
		if ! tty_read answer; then
			[ "$default" = "y" ]
			return $?
		fi
		answer="${answer:-$default}"
		case "$answer" in
			y | Y | yes | YES | да | Да) return 0 ;;
			n | N | no | NO | нет | Нет) return 1 ;;
			*) warn "ответь y или n" ;;
		esac
	done
}

choose() {
	local prompt="$1" def="$2" answer=""
	shift 2
	printf '%s\n' "$prompt" >&2
	local item
	for item in "$@"; do
		printf '  %s\n' "$item" >&2
	done
	printf 'Выбор [%s]: ' "$def" >&2
	tty_read answer || answer=""
	printf '%s' "${answer:-$def}"
}

need_root() {
	[ "$(id -u)" -eq 0 ] && return 0
	command -v sudo >/dev/null 2>&1 || die "запусти от root (sudo нет в системе)"
	ok "перезапуск через sudo"
	exec sudo -E bash "${BASH_SOURCE[0]}" "${ORIG_ARGS[@]}"
}

check_os() {
	[ -r /etc/os-release ] || die "не вижу /etc/os-release — поддерживаются Ubuntu и Debian"
	# shellcheck disable=SC1091
	. /etc/os-release
	OS_NAME="${PRETTY_NAME:-$ID}"
	command -v apt-get >/dev/null 2>&1 || die "$OS_NAME без apt-get: ставь Docker сам и запусти с --dir на готовый каталог"
	ok "система: $OS_NAME"
}

rand_hex() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 32
	else
		head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
	fi
}

install_packages() {
	export DEBIAN_FRONTEND=noninteractive
	title "Пакеты"
	say "ставлю docker, git, curl, openssl (может занять пару минут)"
	apt-get update -qq || die "apt-get update не прошёл"
	apt-get install -y -qq ca-certificates curl git openssl docker.io docker-compose-v2 >/dev/null ||
		apt-get install -y -qq ca-certificates curl git openssl docker.io docker-compose-plugin >/dev/null ||
		die "не удалось поставить docker.io + compose"
	apt-get install -y -qq docker-buildx >/dev/null 2>&1 || warn "docker-buildx нет в репозитории — сборка пойдёт без него"
	systemctl enable --now docker >/dev/null 2>&1 || warn "не удалось включить docker в systemd"
	docker_ready
}

docker_ready() {
	command -v docker >/dev/null 2>&1 || die "docker не установлен"
	docker info >/dev/null 2>&1 || die "демон docker не отвечает (systemctl start docker)"
	docker compose version >/dev/null 2>&1 || die "нет плагина docker compose (пакет docker-compose-v2)"
	ok "$(docker --version | cut -d, -f1), $(docker compose version --short 2>/dev/null || echo 'compose 2')"
}

public_ip() {
	local ip=""
	ip="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null)" || ip=""
	[ -n "$ip" ] || ip="$(curl -4 -fsS --max-time 8 https://ifconfig.me 2>/dev/null)" || ip=""
	[ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
	printf '%s' "$ip"
}

dns_v4() {
	getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u
}

in_cloudflare() {
	local ip="$1" nets
	command -v python3 >/dev/null 2>&1 || return 1
	nets="$(curl -4 -fsS --max-time 8 https://www.cloudflare.com/ips-v4 2>/dev/null)" || return 1
	[ -n "$nets" ] || return 1
	printf '%s\n' "$nets" | python3 -c '
import ipaddress, sys
ip = sys.argv[1]
try:
    addr = ipaddress.ip_address(ip)
except ValueError:
    sys.exit(1)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        if addr in ipaddress.ip_network(line, strict=False):
            sys.exit(0)
    except ValueError:
        continue
sys.exit(1)
' "$ip"
}

env_get() {
	local file="$APP_DIR/.env" key="$1"
	[ -f "$file" ] || return 0
	sed -n -E "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$file" | tail -n 1 | tr -d "\"'"
}

env_set() {
	local file="$APP_DIR/.env" key="$1" value="$2" tmp
	mkdir -p "$APP_DIR"
	tmp="$(mktemp)"
	if [ -f "$file" ]; then
		grep -v -E "^[[:space:]]*${key}[[:space:]]*=" "$file" >"$tmp" || true
	fi
	printf '%s=%s\n' "$key" "$value" >>"$tmp"
	mv "$tmp" "$file"
	chmod 600 "$file"
}

compose_args() {
	COMPOSE_ARGS=(-f docker-compose.tls.yml)
	case "$ACCESS" in
		ip) COMPOSE_ARGS+=(-f docker-compose.ip.yml) ;;
	esac
	case "$ACCESS" in
		caddy) COMPOSE_ARGS+=(--profile caddy) ;;
		tunnel) COMPOSE_ARGS+=(--profile cfdomain) ;;
	esac
}

compose() {
	( cd "$APP_DIR" && CF_TUNNEL_TOKEN="${TOKEN:-unused}" docker compose "${COMPOSE_ARGS[@]}" "$@" )
}

ensure_sources() {
	if [ -f "$APP_DIR/docker-compose.tls.yml" ] && [ -d "$APP_DIR/server" ]; then
		ok "исходники: $APP_DIR"
		return 0
	fi
	command -v git >/dev/null 2>&1 || die "нет git — не из чего развернуть $APP_DIR"
	if [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
		die "$APP_DIR занят, но это не каталог с исходниками StarkFlow (нет docker-compose.tls.yml) — укажи другой --dir"
	fi
	title "Исходники"
	say "клонирую $REPO_URL в $APP_DIR"
	mkdir -p "$(dirname -- "$APP_DIR")"
	git clone --depth 1 "$REPO_URL" "$APP_DIR" || die "git clone не прошёл"
	ok "исходники: $APP_DIR"
}

pick_mode() {
	[ "$MODE_SET" = "1" ] && return 0
	if [ "$ASSUME_YES" = "1" ]; then
		MODE="node"
		MODE_SET=1
		return 0
	fi
	local c
	c="$(choose "Что ставим на этот сервер?" 1 \
		"1) нода — игровой сервер (обычный вариант, для одной локации)" \
		"2) directory — распределитель: раздаёт игроков по нодам разных регионов")"
	case "$c" in
		2) MODE="directory" ;;
		*) MODE="node" ;;
	esac
	MODE_SET=1
}

pick_access() {
	[ "$ACCESS_SET" = "1" ] && return 0
	if [ "$ASSUME_YES" = "1" ]; then
		[ -n "$DOMAIN" ] && ACCESS="caddy" || ACCESS="ip"
		ACCESS_SET=1
		return 0
	fi
	local c
	c="$(choose "Как игроки будут подключаться?" 1 \
		"1) свой домен + https через Caddy (A-запись на этот IP, порты 80/443)" \
		"2) домен через Cloudflare Tunnel (порты открывать не нужно, нужен токен)" \
		"3) без домена: http://IP:8080 (быстро, но из https-игры ws:// не откроется)")"
	case "$c" in
		2) ACCESS="tunnel" ;;
		3) ACCESS="ip" ;;
		*) ACCESS="caddy" ;;
	esac
	ACCESS_SET=1
}

valid_domain() {
	printf '%s' "$1" | grep -Eq '^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$'
}

ask_domain() {
	[ -n "$DOMAIN" ] && return 0
	if [ "$ASSUME_YES" = "1" ]; then
		die "нужен --domain имя.домена (или --no-domain)"
	fi
	if ! have_tty; then
		die "нет терминала для ввода домена — запусти с --domain имя.домена"
	fi
	local tries=0
	while [ "$tries" -lt 5 ]; do
		DOMAIN="$(ask 'Домен (например game.example.com)')"
		if valid_domain "$DOMAIN"; then
			return 0
		fi
		tries=$((tries + 1))
		warn "это не похоже на домен: ${DOMAIN:-пусто}"
	done
	die "домен так и не введён — используй --domain имя.домена"
}

check_domain() {
	local domain="$1" me ips ip proxied=0
	me="$(public_ip)"
	ips="$(dns_v4 "$domain")"
	if [ -z "$ips" ]; then
		warn "A-запись $domain пока не видна в DNS"
		say "  создай запись A: $domain -> $me, подожди минуту и запусти скрипт заново"
		return 1
	fi
	if [ -n "$me" ] && printf '%s\n' "$ips" | grep -qx "$me"; then
		ok "$domain -> $me (этот сервер)"
		return 0
	fi
	while read -r ip; do
		[ -n "$ip" ] || continue
		if in_cloudflare "$ip"; then
			proxied=1
		fi
	done <<EOF
$ips
EOF
	if [ "$proxied" = "1" ]; then
		warn "$domain сейчас за прокси Cloudflare (оранжевое облако)"
		say "  Let's Encrypt не подтвердит домен: HTTP-01 и TLS-ALPN проходят через прокси и до сервера не доходят."
		say "  Что сделать: Cloudflare -> DNS -> запись A -> Proxy status = DNS only (серое облако),"
		say "  подождать минуту и запустить скрипт заново. Либо выбрать вариант 2 (Cloudflare Tunnel)."
		return 1
	else
		warn "$domain указывает на $(printf '%s' "$ips" | tr '\n' ' ')"
		say "  этот сервер: $me — сертификат не выпустится, пока A-запись смотрит в другое место"
		return 1
	fi
}

ask_rtc() {
	[ -n "$RTC_PORT" ] && return 0
	[ "$ASSUME_YES" = "1" ] && return 0
	if ask_yn "Включить WebRTC-канал для синка объектов (UDP, необязательно)" n; then
		RTC_PORT="$(ask 'UDP-порт для WebRTC' 40000)"
		RTC_IP="$(ask 'Внешний IP сервера (пусто = определить самому)' '')"
	fi
}

write_env() {
	title "Конфигурация"
	mkdir -p "$APP_DIR"
	local secret origin me
	secret="$(env_get STARKFLOW_SECRET)"
	if [ -z "$secret" ]; then
		secret="$(rand_hex)"
		ok "STARKFLOW_SECRET сгенерирован"
	else
		ok "STARKFLOW_SECRET уже был — оставил прежний (токены игроков не слетят)"
	fi
	env_set STARKFLOW_SECRET "$secret"
	env_set STARKFLOW_ADDR ":8080"
	me="$(public_ip)"
	origin=""
	case "$ACCESS" in
		ip)
			env_set STARKFLOW_PORT "$HTTP_PORT"
			if [ "$HTTP_PORT" = "80" ]; then
				origin="http://$me"
			else
				origin="http://$me:$HTTP_PORT"
			fi
			;;
		*)
			[ -n "$DOMAIN" ] || die "для https нужен домен"
			env_set SF_DOMAIN "$DOMAIN"
			origin="https://$DOMAIN"
			;;
	esac
	env_set STARKFLOW_ORIGINS "$origin"
	if [ "$MODE" = "directory" ]; then
		env_set STARKFLOW_MODE "directory"
		[ -n "$(env_get STARKFLOW_CLUSTER_SECRET)" ] || env_set STARKFLOW_CLUSTER_SECRET "$(rand_hex)"
		[ -n "$(env_get STARKFLOW_ADMIN_TOKEN)" ] || env_set STARKFLOW_ADMIN_TOKEN "$(rand_hex)"
	else
		env_set STARKFLOW_MODE "node"
	fi
	if [ -n "$RTC_PORT" ]; then
		env_set STARKFLOW_RTC_PORT "$RTC_PORT"
		env_set STARKFLOW_RTC_PUBLIC_IP "${RTC_IP:-$me}"
	fi
	ok "режим: $MODE, доступ: $ACCESS, origin: $origin"
	ok "конфиг: $APP_DIR/.env"
}

open_firewall() {
	local rtc="$RTC_PORT"
	command -v ufw >/dev/null 2>&1 || {
		warn "ufw нет: порты проверяй в фаерволе панели VPS"
		return 0
	}
	if ! ufw status 2>/dev/null | grep -q "Status: active"; then
		warn "ufw выключен — правила не нужны, но фаервол панели VPS проверь сам"
		return 0
	fi
	ufw allow 22/tcp >/dev/null 2>&1
	case "$ACCESS" in
		caddy)
			ufw allow 80/tcp >/dev/null 2>&1
			ufw allow 443/tcp >/dev/null 2>&1
			ufw allow 443/udp >/dev/null 2>&1
			ok "ufw: 22/tcp, 80/tcp, 443/tcp, 443/udp"
			;;
		ip)
			ufw allow "$HTTP_PORT/tcp" >/dev/null 2>&1
			ok "ufw: 22/tcp, $HTTP_PORT/tcp"
			;;
		tunnel)
			ok "ufw: 22/tcp (туннель работает исходящими соединениями)"
			;;
	esac
	if [ -n "$rtc" ]; then
		ufw allow "$rtc/udp" >/dev/null 2>&1
		ok "ufw: $rtc/udp (WebRTC)"
	fi
}

start_stack() {
	title "Сборка и запуск"
	say "docker compose ${COMPOSE_ARGS[*]} up -d --build"
	say "(первый раз 2–5 минут: тянется образ Go и собирается бинарник)"
	compose up -d --build || die "docker compose up не прошёл, логи: bash install.sh --logs"
}

wait_healthy() {
	local cid status
	for _ in $(seq 1 60); do
		cid="$(compose ps -q starkflow 2>/dev/null | head -n 1)"
		if [ -n "$cid" ]; then
			status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)"
			if [ "$status" = "healthy" ]; then
				ok "контейнер отвечает на /health"
				return 0
			fi
		fi
		sleep 3
	done
	warn "healthcheck не позеленел за 3 минуты"
	return 1
}

verify_access() {
	title "Проверка"
	case "$ACCESS" in
		ip)
			if curl -fsS -m 5 "http://127.0.0.1:$HTTP_PORT/health" 2>/dev/null | grep -q ok; then
				ok "http://127.0.0.1:$HTTP_PORT/health -> ok"
			else
				warn "локальный /health не ответил"
			fi
			;;
		caddy)
			for _ in $(seq 1 24); do
				if curl -fsS -m 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health" 2>/dev/null | grep -q ok; then
					ok "https://$DOMAIN/health -> ok, сертификат на месте"
					return 0
				fi
				sleep 5
			done
			warn "https://$DOMAIN/health пока не отвечает"
			say "  сертификат выдаётся 10–60 секунд: bash install.sh --logs (ищи 'certificate obtained')"
			say "  если в логе 'challenge failed' — домен закрыт прокси Cloudflare (нужно DNS only)"
			;;
		tunnel)
			say "туннель поднимается 5–15 секунд, проверь https://$DOMAIN/health снаружи"
			;;
	esac
}

print_summary() {
	local ws page admin=""
	title "Готово"
	case "$ACCESS" in
		ip)
			ws="ws://$(public_ip):$HTTP_PORT/ws"
			page="http://$(public_ip):$HTTP_PORT/"
			;;
		*)
			ws="wss://$DOMAIN/ws"
			page="https://$DOMAIN/"
			;;
	esac
	hr
	say "Страница:              $page"
	say "Адрес для плагина C3:  ${C_BOLD}$ws${C_RESET}"
	if [ "$MODE" = "directory" ]; then
		case "$ACCESS" in
			ip) admin="http://$(public_ip):$HTTP_PORT/admin/" ;;
			*) admin="https://$DOMAIN/admin/" ;;
		esac
		say "Админ-панель:          $admin"
		say "Токен админа:          $(env_get STARKFLOW_ADMIN_TOKEN)"
		say "Секрет кластера:       $(env_get STARKFLOW_CLUSTER_SECRET)"
	fi
	if [ -n "$RTC_PORT" ]; then
		say "WebRTC (UDP):          $RTC_PORT (STARKFLOW_RTC_PUBLIC_IP=$(env_get STARKFLOW_RTC_PUBLIC_IP))"
	fi
	hr
	say "Статус:   bash install.sh --status"
	say "Логи:     bash install.sh --logs"
	say "Обновить: bash install.sh --update"
	say "Остановить: bash install.sh --down"
	hr
	warn "не забудь открыть эти порты в фаерволе панели VPS, иначе снаружи не достучится"
}

load_config() {
	[ -d "$APP_DIR" ] || die "нет каталога $APP_DIR — сначала запусти установку"
	MODE="$(env_get STARKFLOW_MODE)"
	MODE="${MODE:-node}"
	DOMAIN="$(env_get SF_DOMAIN)"
	HTTP_PORT="$(env_get STARKFLOW_PORT)"
	HTTP_PORT="${HTTP_PORT:-8080}"
	RTC_PORT="$(env_get STARKFLOW_RTC_PORT)"
	RTC_IP="$(env_get STARKFLOW_RTC_PUBLIC_IP)"
	ACCESS="$(env_get INSTALL_ACCESS)"
	if [ -z "$ACCESS" ]; then
		if [ -n "$DOMAIN" ]; then ACCESS="caddy"; else ACCESS="ip"; fi
	fi
	TOKEN="${TOKEN:-$(env_get CF_TUNNEL_TOKEN)}"
	compose_args
}

run_status() {
	load_config
	title "Статус"
	compose ps
	say ""
	say "режим: $MODE, доступ: $ACCESS, домен: ${DOMAIN:-нет}"
	case "$ACCESS" in
		ip)
			curl -fsS -m 5 "http://127.0.0.1:$HTTP_PORT/health" >/dev/null 2>&1 &&
				ok "http://127.0.0.1:$HTTP_PORT/health -> ok" ||
				warn "локальный /health не ответил"
			;;
		*)
			[ -n "$DOMAIN" ] && {
				curl -fsS -m 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/health" 2>/dev/null | grep -q ok &&
					ok "https://$DOMAIN/health -> ok" ||
					warn "https://$DOMAIN/health не ответил"
			}
			;;
	esac
}

run_logs() {
	load_config
	compose logs -f --tail 50
}

run_down() {
	need_root
	load_config
	compose down
	ok "остановлено (данные в .env остались, секрет не слетел)"
}

run_update() {
	need_root
	load_config
	title "Обновление"
	if [ -d "$APP_DIR/.git" ]; then
		git -C "$APP_DIR" pull --ff-only || warn "git pull не прошёл — собираю то, что уже лежит"
	else
		warn "в $APP_DIR нет .git — код не обновляю, только пересобираю"
	fi
	start_stack
	wait_healthy || true
	verify_access
	print_summary
}

run_install() {
	need_root
	check_os
	if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
		docker_ready
	else
		install_packages
	fi
	pick_mode
	pick_access
	case "$ACCESS" in
		caddy)
			ask_domain
			check_domain "$DOMAIN" || warn "продолжаю: запусти скрипт заново после того, как поправишь DNS"
			;;
		tunnel)
			ask_domain
			if [ -z "$TOKEN" ]; then
				TOKEN="$(ask 'Токен Cloudflare Tunnel (Zero Trust -> Networks -> Tunnels)')"
			fi
			[ -n "$TOKEN" ] || die "без токена туннель не поднимется"
			;;
	esac
	ask_rtc
	ensure_sources
	compose_args
	write_env
	env_set INSTALL_ACCESS "$ACCESS"
	open_firewall
	start_stack
	wait_healthy || true
	verify_access
	print_summary
}

usage() {
	cat <<'EOF'
Установщик StarkFlow: VPS + Docker + свой домен с https (wss://).

  bash install.sh                          интерактивно: меню и вопросы
  bash install.sh --domain game.example.com --yes
  bash install.sh --no-domain --yes        http://IP:8080 без https
  bash install.sh --mode directory --domain dir.example.com --yes
  bash install.sh --token eyJhIjoi... --domain game.example.com --yes

Флаги:
  --domain D        домен для https (A-запись на этот сервер, порты 80/443)
  --no-domain       без домена, наружу публикуется --port (по умолчанию 8080)
  --mode M          node (игровой сервер, по умолчанию) или directory
  --token T         токен Cloudflare Tunnel: домен без открытых портов
  --rtc-port N      включить WebRTC-канал для синка (UDP)
  --rtc-ip IP       внешний IP для WebRTC (по умолчанию определяется сам)
  --port N          порт для режима без домена (по умолчанию 8080)
  --dir PATH        каталог с исходниками (по умолчанию /opt/starkflow)
  -y, --yes         без вопросов (нужен --domain или --no-domain)

Действия:
  --status  контейнеры, режим и /health
  --logs    логи в реальном времени
  --update  git pull и пересборка
  --down    остановить
EOF
}

main_menu() {
	local c
	if ! have_tty; then
		usage
		exit 1
	fi
	title "StarkFlow — установка на VPS"
	say "1) Установить / перенастроить"
	say "2) Статус"
	say "3) Логи"
	say "4) Обновить (git pull + пересборка)"
	say "5) Остановить"
	say "0) Выход"
	c="$(ask 'Выбор' 1)"
	case "$c" in
		1) run_install ;;
		2) run_status ;;
		3) run_logs ;;
		4) run_update ;;
		5) run_down ;;
		*) exit 0 ;;
	esac
}

parse_args() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--domain)
				DOMAIN="${2:-}"
				ACCESS="caddy"
				ACCESS_SET=1
				shift 2
				;;
			--no-domain)
				ACCESS="ip"
				ACCESS_SET=1
				shift
				;;
			--mode)
				MODE="${2:-}"
				MODE_SET=1
				[ "$MODE" = "node" ] || [ "$MODE" = "directory" ] || die "--mode: node или directory"
				shift 2
				;;
			--token)
				TOKEN="${2:-}"
				ACCESS="tunnel"
				ACCESS_SET=1
				shift 2
				;;
			--rtc-port)
				RTC_PORT="${2:-}"
				shift 2
				;;
			--rtc-ip)
				RTC_IP="${2:-}"
				shift 2
				;;
			--port)
				HTTP_PORT="${2:-}"
				shift 2
				;;
			--dir)
				APP_DIR="${2:-}"
				shift 2
				;;
			-y | --yes)
				ASSUME_YES=1
				shift
				;;
			--status)
				ACTION="status"
				shift
				;;
			--logs)
				ACTION="logs"
				shift
				;;
			--update)
				ACTION="update"
				shift
				;;
			--down)
				ACTION="down"
				shift
				;;
			--help | -h)
				usage
				exit 0
				;;
			*)
				die "неизвестный аргумент: $1 (см. --help)"
				;;
		esac
	done
}

main() {
	ORIG_ARGS=("$@")
	MODE_SET="${MODE_SET:-0}"
	ACCESS_SET="${ACCESS_SET:-0}"
	[ -f "$SCRIPT_DIR/docker-compose.tls.yml" ] && [ -d "$SCRIPT_DIR/server" ] && APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
	APP_DIR="${APP_DIR:-$DEFAULT_DIR}"
	if [ "$#" -eq 0 ]; then
		main_menu
		return
	fi
	parse_args "$@"
	case "$ACTION" in
		install) run_install ;;
		status) run_status ;;
		logs) run_logs ;;
		update) run_update ;;
		down) run_down ;;
		*) die "неизвестное действие: $ACTION" ;;
	esac
}

main "$@"




