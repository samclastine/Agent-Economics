#!/usr/bin/env bash
# Dry-run by default. Source-verification submission is a separate, explicit step.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${A423_CHAIN_ID:?set A423_CHAIN_ID}"
: "${A423_RPC_URL:?set A423_RPC_URL}"
: "${A423_TOKEN_ADDRESS:?set A423_TOKEN_ADDRESS}"
: "${A423_DEPLOYER_KEY:?set A423_DEPLOYER_KEY}"
echo "Testnet deployment wrapper. No transaction is broadcast unless --broadcast is passed."
echo "Source verification submission (Sourcify) is separate from completed verification."
exec node node_modules/@allorc/a423-sdk/scripts/deploy-escrow.mjs "$@"
