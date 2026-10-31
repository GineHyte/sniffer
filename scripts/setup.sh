#!/usr/bin/env bash
# One-shot local setup for Sniffer. Safe to re-run: it never overwrites existing
# secrets, wallets or keys unless you type a new value.
#   1. checks/installs requirements (Node 24, bun, Docker, openssl, Sokosumi CLI)
#   2. installs packages, creates config files, generated secrets and the service wallets
#      (the demo's customer wallet and funding are in scripts/demo-setup.sh)
#   3. asks for the API keys and writes them to .env
set -euo pipefail

cd "$(dirname "$0")/.."
SOKOSUMI_VERSION=1.0.4

# shellcheck source=scripts/setup-common.sh
. scripts/setup-common.sh

# ---------------------------------------------------------------------------
step "1/4 Requirements"

ensure_node24
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
for w in main-payer intake inv-invoice inv-wallet inv-supplier; do
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
  1. Log in to Sokosumi:  sokosumi --preprod auth login
     then set up the Vendor and Coworkers (README "Set up Sokosumi").
  2. Start the backend:   npm run stack
  3. Before a demo:       bun run demo:setup   (creates the test customer wallet, checks funding)
EOF
node_path_hint
