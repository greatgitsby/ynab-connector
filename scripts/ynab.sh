#!/usr/bin/env bash
# Direct YNAB API helper for local e2e testing — bypasses the MCP layer so
# you can compare raw API responses against what a tool returns.
#
# Subcommands:
#   ./scripts/ynab.sh url               Print the YNAB OAuth authorize URL (full scope)
#   ./scripts/ynab.sh exchange CODE     Trade an authorization code for tokens
#   ./scripts/ynab.sh refresh           Refresh the saved access token
#   ./scripts/ynab.sh api PATH [...]    GET api.ynab.com/v1$PATH (extra args go to curl)
#   ./scripts/ynab.sh patch PATH BODY   PATCH with a JSON body (- to read body from stdin)
#   ./scripts/ynab.sh put   PATH BODY   PUT with a JSON body
#   ./scripts/ynab.sh post  PATH BODY   POST with a JSON body
#
# Files:
#   .dev.vars          Source of YNAB_CLIENT_ID / YNAB_CLIENT_SECRET (you create this)
#   .dev.vars.tokens   Managed by this script; access/refresh tokens + expiry
#
# Requires: curl, jq.

set -euo pipefail
cd "$(dirname "$0")/.."

DOTENV=.dev.vars
TOKENS=.dev.vars.tokens
REDIRECT='http://localhost:8787/callback'
TOKEN_URL='https://app.ynab.com/oauth/token'
API_BASE='https://api.ynab.com/v1'

need_dotenv() {
  [[ -s $DOTENV ]] || { echo "error: $DOTENV missing — cp .dev.vars.example $DOTENV and fill it in" >&2; exit 1; }
  set -a; source "$DOTENV"; set +a
}

need_tokens() {
  [[ -s $TOKENS ]] || { echo "error: $TOKENS missing — run \`$0 exchange CODE\` first" >&2; exit 1; }
  set -a; source "$TOKENS"; set +a
}

# $1 = JSON token response. Writes .dev.vars.tokens or dies with the error body.
save_tokens() {
  local json=$1 at rt exp
  at=$(jq -r '.access_token // ""' <<<"$json")
  if [[ -z $at ]]; then
    echo "error: token exchange failed:" >&2
    echo "$json" >&2
    exit 1
  fi
  rt=$(jq -r '.refresh_token // ""' <<<"$json")
  exp=$(jq -r '.expires_in // 0' <<<"$json")
  local expires_at=$(( $(date +%s) + exp ))
  {
    echo "YNAB_ACCESS_TOKEN=$at"
    echo "YNAB_REFRESH_TOKEN=$rt"
    echo "YNAB_EXPIRES_AT=$expires_at"
  } > "$TOKENS"
  echo "saved $TOKENS (expires $(date -r "$expires_at" 2>/dev/null || date -d "@$expires_at"))"
}

cmd_url() {
  need_dotenv
  local enc
  enc=$(jq -rn --arg s "$REDIRECT" '$s|@uri')
  echo "https://app.ynab.com/oauth/authorize?client_id=$YNAB_CLIENT_ID&redirect_uri=$enc&response_type=code"
}

cmd_exchange() {
  need_dotenv
  local code=${1:-}
  [[ -n $code ]] || { echo "usage: $0 exchange CODE" >&2; exit 1; }
  local resp
  resp=$(curl -sS -X POST "$TOKEN_URL" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "client_id=$YNAB_CLIENT_ID" \
    -d "client_secret=$YNAB_CLIENT_SECRET" \
    -d "redirect_uri=$REDIRECT" \
    -d "grant_type=authorization_code" \
    -d "code=$code")
  save_tokens "$resp"
}

cmd_refresh() {
  need_dotenv
  need_tokens
  local resp
  resp=$(curl -sS -X POST "$TOKEN_URL" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "client_id=$YNAB_CLIENT_ID" \
    -d "client_secret=$YNAB_CLIENT_SECRET" \
    -d "grant_type=refresh_token" \
    -d "refresh_token=$YNAB_REFRESH_TOKEN")
  save_tokens "$resp"
}

cmd_api() {
  need_dotenv
  need_tokens
  local path=${1:-}
  [[ -n $path ]] || { echo "usage: $0 api PATH [curl args...]" >&2; exit 1; }
  shift
  [[ ${path:0:1} == / ]] || path="/$path"
  # Refresh proactively if we know the token is past expiry.
  if [[ -n ${YNAB_EXPIRES_AT:-} && $(date +%s) -ge $YNAB_EXPIRES_AT ]]; then
    cmd_refresh >&2
    set -a; source "$TOKENS"; set +a
  fi
  local resp status body
  resp=$(curl -sS -w $'\n%{http_code}' \
    -H "Authorization: Bearer $YNAB_ACCESS_TOKEN" \
    "$@" "$API_BASE$path")
  status=${resp##*$'\n'}
  body=${resp%$'\n'*}
  # One retry on 401 in case the expiry tracking is stale.
  if [[ $status == 401 ]]; then
    cmd_refresh >&2
    set -a; source "$TOKENS"; set +a
    resp=$(curl -sS -w $'\n%{http_code}' \
      -H "Authorization: Bearer $YNAB_ACCESS_TOKEN" \
      "$@" "$API_BASE$path")
    status=${resp##*$'\n'}
    body=${resp%$'\n'*}
  fi
  echo "$body"
  if (( status >= 400 )); then
    echo "HTTP $status" >&2
    exit 1
  fi
}

# Shared mutator: $1 = HTTP method, $2 = path, $3 = JSON body (or `-` for stdin).
# Sets Content-Type and forwards to cmd_api so we get token refresh for free.
cmd_write() {
  local method=${1:-} path=${2:-} body=${3:-}
  [[ -n $method && -n $path && -n $body ]] || {
    echo "usage: $0 ${method,,} PATH BODY   (BODY may be '-' for stdin)" >&2
    exit 1
  }
  if [[ $body == "-" ]]; then body=$(cat); fi
  cmd_api "$path" -X "$method" -H "Content-Type: application/json" --data "$body"
}

case "${1:-help}" in
  url) shift; cmd_url "$@" ;;
  exchange) shift; cmd_exchange "$@" ;;
  refresh) shift; cmd_refresh "$@" ;;
  api) shift; cmd_api "$@" ;;
  patch) shift; cmd_write PATCH "$@" ;;
  put) shift; cmd_write PUT "$@" ;;
  post) shift; cmd_write POST "$@" ;;
  *)
    sed -n '2,/^$/p' "$0" >&2
    exit 1
    ;;
esac
