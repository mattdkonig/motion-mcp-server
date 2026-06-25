#!/usr/bin/env bash
set -euo pipefail

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
BLUE=$'\033[0;34m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

say() { printf '%s\n' "${BLUE}${BOLD}==>${RESET} $*"; }
ok() { printf '%s\n' "${GREEN}${BOLD}✓${RESET} $*"; }
warn() { printf '%s\n' "${YELLOW}${BOLD}WARN:${RESET} $*"; }
die() { printf '%s\n' "${RED}${BOLD}ERROR:${RESET} $*" >&2; exit 1; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
STATE_PATH="${CLASSPASS_STORAGE_STATE:-./data/state.json}"
NAMED_TUNNEL="${CLOUDFLARED_TUNNEL_NAME:-classpass-mcp}"
SERVER_LOG="${PROJECT_DIR}/data/server.log"
TUNNEL_LOG="${PROJECT_DIR}/data/tunnel.log"
SERVER_PID=""
TUNNEL_PID=""

cleanup() {
  if [[ -n "${TUNNEL_PID}" ]] && kill -0 "${TUNNEL_PID}" 2>/dev/null; then
    kill "${TUNNEL_PID}" 2>/dev/null || true
  fi
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 32
    printf '\n'
  fi
}

wait_for_health() {
  local url="http://127.0.0.1:${PORT}/health"
  for _ in $(seq 1 60); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

extract_tunnel_url() {
  grep -Eo 'https://[^[:space:]]+' "${TUNNEL_LOG}" | grep -Ev 'cloudflare\\.com|github\\.com' | tail -n 1 || true
}

wait_for_tunnel_url() {
  for _ in $(seq 1 90); do
    local url
    url="$(extract_tunnel_url)"
    if [[ -n "${url}" ]]; then
      printf '%s\n' "${url%/}"
      return 0
    fi
    sleep 1
  done
  return 1
}

named_tunnel_exists() {
  command -v cloudflared >/dev/null 2>&1 || return 1
  cloudflared tunnel list 2>/dev/null | awk -v name="${NAMED_TUNNEL}" 'NR > 1 && $2 == name { found = 1 } END { exit found ? 0 : 1 }'
}

configured_named_tunnel_hostname() {
  local config hostname
  for config in "${CLOUDFLARED_CONFIG:-}" "${HOME}/.cloudflared/config.yml" "${HOME}/.cloudflared/config.yaml"; do
    [[ -n "${config}" && -f "${config}" ]] || continue
    hostname="$(
      awk '
        $1 == "hostname:" {
          host = $2
          gsub(/["'\'']/, "", host)
          if (host != "" && host != "*") {
            print host
            exit
          }
        }
      ' "${config}"
    )"
    if [[ -n "${hostname}" ]]; then
      printf '%s\n' "${hostname}"
      return 0
    fi
  done
  return 1
}

self_test_mcp() {
  local connector_url="$1"
  local payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"classpass-local-smoke","version":"1.0.0"}}}'
  for _ in $(seq 1 20); do
    if curl -fsS -X POST "${connector_url}" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -d "${payload}" | grep -q 'protocolVersion'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

command -v node >/dev/null 2>&1 || die "Node.js is required."
command -v npm >/dev/null 2>&1 || die "npm is required."
command -v curl >/dev/null 2>&1 || die "curl is required."

cd "${PROJECT_DIR}"
mkdir -p data

say "Installing Node dependencies"
npm install

say "Installing Playwright Chromium"
npx playwright install chromium

MCP_SECRET="${MCP_SECRET:-$(generate_secret)}"
export MCP_SECRET
export PORT
export CLASSPASS_STORAGE_STATE="${STATE_PATH}"

say "Opening ClassPass for one-time manual login"
npm run login

if [[ ! -f "${STATE_PATH}" ]]; then
  die "Expected saved ClassPass session at ${STATE_PATH}, but it was not created."
fi
ok "Saved ClassPass session found at ${STATE_PATH}"

say "Starting local ClassPass MCP server on port ${PORT}"
: >"${SERVER_LOG}"
npm start >"${SERVER_LOG}" 2>&1 &
SERVER_PID="$!"

if ! wait_for_health; then
  warn "Server log:"
  sed -n '1,120p' "${SERVER_LOG}" >&2 || true
  die "Server did not become healthy on http://127.0.0.1:${PORT}/health"
fi
ok "Server is healthy"

say "Starting public tunnel"
: >"${TUNNEL_LOG}"
PUBLIC_URL=""
TUNNEL_MODE=""
if command -v cloudflared >/dev/null 2>&1; then
  if named_tunnel_exists; then
    STABLE_HOSTNAME="$(configured_named_tunnel_hostname || true)"
    if [[ -n "${STABLE_HOSTNAME}" ]]; then
      say "Using existing cloudflared named tunnel '${NAMED_TUNNEL}'"
      cloudflared tunnel run "${NAMED_TUNNEL}" >"${TUNNEL_LOG}" 2>&1 &
      TUNNEL_PID="$!"
      PUBLIC_URL="https://${STABLE_HOSTNAME}"
      TUNNEL_MODE="named"
    else
      warn "Found named tunnel '${NAMED_TUNNEL}', but no hostname was found in ~/.cloudflared/config.yml; using quick tunnel."
    fi
  fi

  if [[ -z "${PUBLIC_URL}" ]]; then
    say "Using cloudflared quick tunnel"
    cloudflared tunnel --url "http://localhost:${PORT}" >"${TUNNEL_LOG}" 2>&1 &
    TUNNEL_PID="$!"
    TUNNEL_MODE="quick"
  fi
else
  warn "cloudflared not found; falling back to localhost.run over ssh"
  command -v ssh >/dev/null 2>&1 || die "ssh is required for localhost.run fallback."
  ssh -o StrictHostKeyChecking=accept-new -R "80:localhost:${PORT}" nokey@localhost.run >"${TUNNEL_LOG}" 2>&1 &
  TUNNEL_PID="$!"
  TUNNEL_MODE="localhost.run"
fi

if [[ -z "${PUBLIC_URL}" ]]; then
  PUBLIC_URL="$(wait_for_tunnel_url)" || {
    warn "Tunnel log:"
    sed -n '1,160p' "${TUNNEL_LOG}" >&2 || true
    die "Could not detect a public tunnel URL."
  }
fi
CONNECTOR_URL="${PUBLIC_URL}/${MCP_SECRET}/mcp"
ok "Tunnel is available at ${PUBLIC_URL} (${TUNNEL_MODE})"

say "Self-testing MCP initialize through the public tunnel"
self_test_mcp "${CONNECTOR_URL}" || {
  warn "Server log:"
  sed -n '1,160p' "${SERVER_LOG}" >&2 || true
  warn "Tunnel log:"
  sed -n '1,160p' "${TUNNEL_LOG}" >&2 || true
  die "MCP initialize self-test failed at ${CONNECTOR_URL}"
}
ok "MCP initialize self-test passed"

cat <<EOF

${GREEN}${BOLD}ClassPass MCP is ready.${RESET}

Paste this connector URL into Claude:

  ${CONNECTOR_URL}

OAuth fields: leave blank.

Keep this terminal open. The local MCP server and tunnel stop when this script exits.
Quick/free tunnel URLs rotate when restarted. A configured cloudflared named tunnel keeps a stable hostname.
EOF

wait "${TUNNEL_PID}"
