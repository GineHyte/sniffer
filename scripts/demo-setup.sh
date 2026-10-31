#!/usr/bin/env bash
# Demo preparation. Run after `bun run setup`. Safe to re-run.
#   1. creates the test customer wallet (`payer`) that pays the demo's intake fee
#   2. runs the read-only preflight: services, Sokosumi login and the balance of
#      every wallet that spends tADA (payer, main-payer, payout) against the
#      minimum for one case; wallets that are short are listed with their address
# Extra arguments go to preflight, e.g. bun run demo:setup -- --new-supplier
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=scripts/setup-common.sh
. scripts/setup-common.sh

FAUCET_URL=https://docs.cardano.org/cardano-testnets/tools/faucet

step "1/2 Test customer wallet"
ensure_node24
[ -f .env ] && [ -f .local/live.env ] || die "config missing; run 'bun run setup' first"
[ -n "$(env_get .env BLOCKFROST_API_KEY_PREPROD)" ] || die "BLOCKFROST_API_KEY_PREPROD is not set; run 'bun run setup' and enter it"
if [ ! -f .local/x402/payer.json ]; then
  node x402/wallets.mjs create payer >/dev/null
  ok "created wallet payer"
fi
ok "payer  $(node x402/wallets.mjs address payer)"

step "2/2 Preflight (read-only)"
if npm run --silent preflight -- "$@"; then
  echo
  ok "Ready. Run the demo with: npm run demo -- --confirm-live-payment"
else
  echo
  warn "Fix the FAIL rows above. For a 'wallet:' row, send test ADA (network Preprod) to its address:"
  echo "    $FAUCET_URL"
  echo "  The faucet can take a minute; then run 'bun run demo:setup' again."
fi
node_path_hint
