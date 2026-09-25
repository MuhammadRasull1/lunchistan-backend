#!/usr/bin/env bash
# Сторож прода Lunchistan: только GET-запросы, ничего не меняет.
# Печатает найденные проблемы (по строке) и выходит с кодом 1, если они есть.
# Каждую проверку повторяет через 20 с — разовый сбой сети не считается падением.
API=${WATCHDOG_API:-https://lunchistan-backend-worker.mansurovsvoyo.workers.dev}  # переопределяется только для проверки самого сторожа
problems=()

probe() { # имя, url, ожидаемый код, [строка, которая должна быть в ответе]
  local name=$1 url=$2 want=$3 needle=${4:-} code body
  for attempt in 1 2; do
    body=$(curl -s -m 20 -w '\n%{http_code}' "$url") || true
    code=${body##*$'\n'}; body=${body%$'\n'*}
    if [ "$code" = "$want" ] && { [ -z "$needle" ] || grep -q -- "$needle" <<<"$body"; }; then return 0; fi
    [ "$attempt" = 1 ] && sleep 20
  done
  problems+=("$name: HTTP $code (ожидалось $want)")
}

probe "API меню"              "$API/api/menu"       200 '"price"'
probe "API настройки"         "$API/api/settings"   200
probe "API закрытые разделы"  "$API/api/my/orders"  401
probe "Приложение клиента"    "https://lunchistan-app.pages.dev"  200 '<div id="root">'
probe "Кабинет владельца"     "https://lunchistan-core.pages.dev" 200 '<div id="root">'

if [ ${#problems[@]} -gt 0 ]; then printf '%s\n' "${problems[@]}"; exit 1; fi
echo "всё в порядке"
