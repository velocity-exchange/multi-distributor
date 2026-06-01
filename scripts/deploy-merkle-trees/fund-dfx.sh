#!/usr/bin/env bash
set -euo pipefail

# Fund the single DFX IOU distributor vault(s). Kept separate from the
# multi-market IF flow on purpose, but shares fund_market() so the CLI call
# never drifts.
#
# The funder keypair must already hold the DFX mint's tokens. Trees must exist
# first (run deploy-dfx.sh). Funding is idempotent: the cli skips vaults
# already funded to max_total_claim.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=scripts/deploy-merkle-trees/deploy-common.sh
source "${SCRIPT_DIR}/deploy-common.sh"

usage() {
  cat <<EOF
Usage: $0 [--config <file>] [--trees-dir <dir>] [--dry-run]

  --config     DFX config JSON (default: scripts/dfx-config.json)
  --trees-dir  Directory holding the trees. Overrides the config's trees_dir;
               falls back to ./dfx-trees. Reads from <trees-dir>/<symbol>/
  --dry-run    Print the CLI commands instead of executing them
  -h, --help   Show this help

Uses the same shared settings and single mint/symbol as deploy-dfx.sh. Funding
only needs the trees dir — no CSV, vesting timestamps, or max_nodes. See
scripts/deploy-merkle-trees/deploy-merkle-trees.md.
EOF
  exit 1
}

CONFIG="${SCRIPT_DIR}/dfx-config.json"
TREES_DIR=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)    CONFIG="$2"; shift 2 ;;
    --trees-dir) TREES_DIR="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done
export DRY_RUN

preflight "$REPO_ROOT" "$CONFIG"
load_shared_config "$CONFIG"

# Directory precedence: CLI flag > config (trees_dir) > built-in default.
[[ -n "$TREES_DIR" ]] || TREES_DIR="$(cfg "$CONFIG" '.trees_dir')"
[[ -n "$TREES_DIR" ]] || TREES_DIR="./dfx-trees"

# Single-mint specifics.
MINT="$(cfg "$CONFIG" '.mint')"
SYMBOL="$(cfg "$CONFIG" '.symbol')"

[[ -n "$MINT" ]] || { echo "Config missing 'mint': $CONFIG" >&2; exit 1; }
[[ -n "$SYMBOL" ]] || { echo "Config missing 'symbol': $CONFIG" >&2; exit 1; }

TREE_DIR="${TREES_DIR}"

echo "==> DFX fund from $CONFIG"
echo "    rpc=$RPC_URL program=$PROGRAM_ID dry-run=$DRY_RUN"
echo

fund_market "$MINT" "$TREE_DIR" "$SYMBOL"

echo
echo "==> Done."
