#!/usr/bin/env bash
# One-shot local setup for Sniffer. Safe to re-run: it never overwrites existing
# secrets, wallets or keys unless you type a new value.
#   1. checks/installs requirements (Node 24, bun, Docker, openssl, Sokosumi CLI)
#   2. installs packages, creates config files, generated secrets and wallets
#   3. asks for the API keys and writes them to .env
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
SOKOSUMI_VERSION=1.0.4

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B= G= Y= R= N=; fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '  %s✗%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
step() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }

# Read KEY's value from an env file (empty if missing).
env_get() { local line; line=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n1) || true; line=${line#*=}; line=${line#\"}; printf '%s' "${line%\"}"; }
# Set KEY=value in an env file without sed (values may contain any character).
env_set() {
  local file=$1 key=$2 value=$3 tmp found=0 line
  tmp=$(mktemp "$file.XXXXXX")
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ $line == "$key="* ]]; then printf '%s=%s\n' "$key" "$value"; found=1; else printf '%s\n' "$line"; fi
  done < "$file" > "$tmp"
  [ "$found" = 1 ] || printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod --reference="$file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# ---------------------------------------------------------------------------
step "1/4 Requirements"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 24 ]; then
  nvm_node=$(ls -d "$HOME"/.nvm/versions/node/v2[4-9]*/bin 2>/dev/null | sort -V | tail -n1 || true)
  if [ -z "$nvm_node" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
    warn "Node $(node_major) found; installing Node 24 with nvm"
    # shellcheck disable=SC1091
    ( set +eu; . "$HOME/.nvm/nvm.sh"; nvm install 24 >/dev/null ) || die "nvm install 24 failed"
    nvm_node=$(ls -d "$HOME"/.nvm/versions/node/v24*/bin | sort -V | tail -n1)
  fi
  [ -n "$nvm_node" ] || die "Node 24+ is required (found $(node_major)). Install it, e.g. with nvm: nvm install 24"
  export PATH="$nvm_node:$PATH"
  NODE_PATH_HINT=$nvm_node
fi
ok "node $(node --version)"

command -v bun >/dev/null || die "bun is required: curl -fsSL https://bun.sh/install | bash"
ok "bun $(bun --version)"

command -v openssl >/dev/null || die "openssl is required"
ok "openssl"

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then ok "docker + compose (daemon running)"; else warn "docker is installed but the daemon is not reachable; start it before 'npm run stack'"; fi
else
  warn "docker + compose not found; needed for the backend stack (npm run stack)"
fi

export PATH="$HOME/.bun/bin:$PATH"
if [ "$(sokosumi --version 2>/dev/null || true)" != "$SOKOSUMI_VERSION" ]; then
  bun add -g "@masumi_network/sokosumi@$SOKOSUMI_VERSION" >/dev/null || die "could not install the Sokosumi CLI"
fi
ok "sokosumi $(sokosumi --version)"

# ---------------------------------------------------------------------------
step "2/4 Packages"
lock_flag=; [ -f bun.lock ] && lock_flag=--frozen-lockfile
out=$(bun install $lock_flag 2>&1) || { printf '%s\n' "$out"; die "bun install failed"; }
ok "dependencies installed (pinned versions)"

# ---------------------------------------------------------------------------
step "3/4 Config, secrets and wallets"
mkdir -p .local && chmod 700 .local
[ -f .env ] || { cp .env.example .env; ok "created .env"; }
chmod 600 .env
[ -f .local/live.env ] || { cp live.env.example .local/live.env; ok "created .local/live.env"; }

if [ ! -f .local/sniffer-secrets.env ]; then
  ( umask 077; printf 'SNIFFER_API_TOKEN=%s\nSNIFFER_HMAC_KEY=%s\nPOSTGRES_PASSWORD=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .local/sniffer-secrets.env )
  ok "generated backend secrets"
else
  ok "backend secrets exist"
fi

wallet_addr() { node x402/wallets.mjs address "$1"; }
for w in payer main-payer intake inv-invoice inv-wallet inv-supplier; do
  [ -f ".local/x402/$w.json" ] || { node x402/wallets.mjs create "$w" >/dev/null; ok "created wallet $w"; }
done
if [ ! -f .local/payout.env ]; then
  node --input-type=module -e "import {PrivateKey} from '@evolution-sdk/evolution'; import {writeFileSync} from 'node:fs'; writeFileSync('.local/payout.env','PAYOUT_MNEMONIC=\"'+PrivateKey.generateMnemonic(256)+'\"\n',{mode:0o600});"
  ok "created payout wallet"
fi
ok "wallets ready"

env_set .local/live.env INTAKE_PAY_TO "$(wallet_addr intake)"
env_set .local/live.env INVESTIGATOR_INVOICE_PAY_TO "$(wallet_addr inv-invoice)"
env_set .local/live.env INVESTIGATOR_WALLET_PAY_TO "$(wallet_addr inv-wallet)"
env_set .local/live.env INVESTIGATOR_SUPPLIER_PAY_TO "$(wallet_addr inv-supplier)"
ok "wallet addresses written to .local/live.env"

# ---------------------------------------------------------------------------
step "4/4 API keys (press Enter to keep the current value)"

# Hidden input; shows only the last 4 characters of an existing key.
read_secret() {
  local key=$1 label=$2 cur value shown="not set"
  cur=$(env_get .env "$key")
  [ -n "$cur" ] && shown="set, …${cur: -4}"
  read -r -s -p "  $label [$shown]: " value; echo
  value=$(printf '%s' "$value" | tr -d '[:space:]')
  [ -n "$value" ] && env_set .env "$key" "$value"
  return 0
}
read_plain() {
  local key=$1 label=$2 cur value
  cur=$(env_get .env "$key")
  read -r -p "  $label [${cur:-not set}]: " value
  [ -n "$value" ] && env_set .env "$key" "$value"
  return 0
}

read_secret ANTHROPIC_API_KEY "Anthropic API key (console.anthropic.com)"
read_secret BLOCKFROST_API_KEY_PREPROD "Blockfrost project ID, Preprod (blockfrost.io)"
read_plain AGENT_AUTHOR "AGENT_AUTHOR (your name or team)"

# Read-only key checks.
key=$(env_get .env ANTHROPIC_API_KEY)
if [ -n "$key" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models \
    -H "x-api-key: $key" -H 'anthropic-version: 2023-06-01' || echo 000)
  [ "$code" = 200 ] && ok "Anthropic key works" || warn "Anthropic key check returned HTTP $code"
else warn "ANTHROPIC_API_KEY is not set"; fi

key=$(env_get .env BLOCKFROST_API_KEY_PREPROD)
if [ -n "$key" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' https://cardano-preprod.blockfrost.io/api/v0/blocks/latest \
    -H "project_id: $key" || echo 000)
  [ "$code" = 200 ] && ok "Blockfrost Preprod key works" || warn "Blockfrost key check returned HTTP $code (is it a Preprod project?)"
else warn "BLOCKFROST_API_KEY_PREPROD is not set"; fi

[ -n "$(env_get .env AGENT_AUTHOR)" ] && ok "AGENT_AUTHOR set" || warn "AGENT_AUTHOR is not set"

# ---------------------------------------------------------------------------
step "Next steps"
cat <<EOF
  1. Fund these wallets with ~10 tADA each (faucet, network Preprod):
       payer       $(wallet_addr payer)
       main-payer  $(wallet_addr main-payer)
       payout      $(node --env-file=.local/payout.env payout/transfer.mjs address)
  2. Log in to Sokosumi:  sokosumi --preprod auth login
     then set up the Vendor and Coworkers (README "Set up Sokosumi").
  3. Start the backend:   npm run stack
EOF
if [ -n "${NODE_PATH_HINT:-}" ]; then
  echo "  Note: your default 'node' is older than 24. Add Node 24 to your PATH, e.g. in fish:"
  echo "        fish_add_path -U $NODE_PATH_HINT"
fi
