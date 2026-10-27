#!/usr/bin/env bash
# Algo Office — установка и запуск одной командой: ./start.sh
# Первый запуск ставит всё нужное и спрашивает ключ OpenRouter, следующие — сразу запускают офис.
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[1;35m!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✖ %s\033[0m\n' "$*"; exit 1; }

# ---------- Node.js ----------
command -v node >/dev/null 2>&1 || fail "Нужен Node.js 22.13 или новее: https://nodejs.org (на Mac: brew install node)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || fail "Node.js $(node -v) слишком старый, нужен 22.13 или новее: https://nodejs.org"
ok "Node.js $(node -v)"

# ---------- .env: пароль и ключ ----------
[ -f .env ] || cp .env.example .env
get_env() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
set_env() {
  local tmp; tmp=$(mktemp)
  awk -v k="$1" -v v="$2" 'BEGIN{d=0} index($0, k"=")==1 {print k"="v; d=1; next} {print} END{if(!d) print k"="v}' .env > "$tmp"
  mv "$tmp" .env
}

if [ -z "$(get_env ADMIN_PASSWORD)" ]; then
  set_env ADMIN_PASSWORD "$(node -e 'console.log(require("crypto").randomBytes(9).toString("base64url"))')"
  ok "Пароль от офиса создан и сохранён в .env"
fi

if [ "$(get_env LLM_PROVIDER)" = "azure" ] || { [ -n "$(get_env AZURE_API_KEY)" ] && [ -z "$(get_env OPENROUTER_API_KEY)" ]; }; then
  USE_AZURE=1
  for v in AZURE_ENDPOINT AZURE_API_KEY MODEL; do
    [ -n "$(get_env $v)" ] || warn "Azure: в .env не заполнено $v — агенты не смогут думать"
  done
  [ -n "$(get_env AZURE_API_KEY)" ] && ok "Модель через Azure: $(get_env MODEL)"
  if [ -n "$(get_env AZURE_OCR_ENDPOINT)" ]; then ok "OCR для фото и сканов: $(get_env OCR_MODEL)"
  else case "$(get_env MODEL)" in *[Dd]eep[Ss]eek*) warn "DeepSeek не видит картинки, а OCR не подключён (AZURE_OCR_ENDPOINT) — текст с фото читаться не будет";; esac; fi
else
  USE_AZURE=""
fi

if [ -z "$USE_AZURE" ] && [ -z "$(get_env OPENROUTER_API_KEY)" ] && [ -t 0 ]; then
  echo
  say "Нужен ключ OpenRouter (https://openrouter.ai/keys). Вставь его и нажми Enter (или просто Enter, чтобы вписать позже в .env):"
  read -r key || key=""
  key=$(printf '%s' "$key" | tr -d '[:space:]')
  [ -n "$key" ] && set_env OPENROUTER_API_KEY "$key" && ok "Ключ сохранён в .env"
fi
[ -n "$USE_AZURE" ] || [ -n "$(get_env OPENROUTER_API_KEY)" ] || warn "Ключа OpenRouter нет — офис откроется, но агенты не смогут думать. Впиши OPENROUTER_API_KEY в .env и перезапусти."

# ---------- зависимости Node ----------
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "Ставлю зависимости (npm ci)…"
  npm ci --no-audit --no-fund --loglevel=error
fi
ok "Зависимости Node"

# ---------- браузер для Гермеса, роликов и PDF ----------
if [ ! -f node_modules/.algo-chromium ]; then
  say "Скачиваю Chromium для Playwright (один раз, ~150 МБ)…"
  if npx playwright install chromium; then
    touch node_modules/.algo-chromium
  else
    warn "Chromium не скачался — браузер, ролики и PDF работать не будут. Попробуй: npx playwright install chromium"
    [ "$(uname)" = "Linux" ] && warn "На Linux могут понадобиться системные библиотеки: sudo npx playwright install-deps chromium"
  fi
fi
[ -f node_modules/.algo-chromium ] && ok "Chromium"

# ---------- Python для чтения и сборки документов ----------
if command -v python3 >/dev/null 2>&1; then
  if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
    say "Ставлю Python-библиотеки для документов в .venv…"
    if { [ -x .venv/bin/python3 ] || python3 -m venv .venv; } && .venv/bin/python3 -m pip install -q --disable-pip-version-check -r requirements.txt; then
      touch .venv/.installed
    else
      warn "Python-библиотеки не поставились — PDF/DOCX/PPTX/XLSX читаться не будут"
    fi
  fi
  [ -f .venv/.installed ] && ok "Python $(python3 -V 2>&1 | cut -d' ' -f2) + библиотеки для документов"
else
  warn "Нет Python 3 — документы (PDF/DOCX/PPTX/XLSX) читаться не будут. Mac: brew install python, Linux: sudo apt install python3 python3-venv"
fi

# ---------- ffmpeg для роликов ----------
if command -v ffmpeg >/dev/null 2>&1; then ok "ffmpeg"
else warn "Нет ffmpeg — ролики собираться не будут. Mac: brew install ffmpeg, Linux: sudo apt install ffmpeg"; fi

# ---------- запуск ----------
PORT=$(get_env PORT); PORT=${PORT:-8080}
URL="http://localhost:$PORT"
echo
ok "Algo Office запускается: $URL"
printf '   Пароль: \033[1m%s\033[0m   (лежит в .env, строка ADMIN_PASSWORD)\n' "$(get_env ADMIN_PASSWORD)"
echo "   Остановить: Ctrl+C"
echo
if command -v open >/dev/null 2>&1; then (sleep 2; open "$URL") >/dev/null 2>&1 &
elif command -v xdg-open >/dev/null 2>&1; then (sleep 2; xdg-open "$URL") >/dev/null 2>&1 & fi
exec node --disable-warning=ExperimentalWarning --env-file=.env src/index.js
