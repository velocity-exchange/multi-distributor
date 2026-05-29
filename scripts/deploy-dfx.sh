#!/usr/bin/env bash
set -euo pipefail

# Deploy the single DFX IOU merkle trees + distributor. Kept separate from the
# multi-market IF flow on purpose, but shares deploy_market() so the CLI-call
# sequence never drifts.
#
# Funding (fund-all) and verify are intentionally MANUAL and out of scope.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/deploy-common.sh
source "${SCRIPT_DIR}/deploy-common.sh"

usage() {
  cat <<EOF
Usage: $0 [--config <file>] [--csv-dir <dir>] [--trees-dir <dir>] [--dry-run]

  --config     DFX config JSON (default: scripts/dfx-config.json)
  --csv-dir    Directory for the CSV when csv_path is not set in config
               (default: ./dfx-csv). Resolves to <csv-dir>/<symbol>.csv
  --trees-dir  Output directory for trees (default: ./dfx-trees)
               Writes to <trees-dir>/<symbol>/
  --dry-run    Print the CLI commands instead of executing them
  -h, --help   Show this help

The config has the same top-level shared keys as the IF config but a single
mint/decimals/symbol (plus an optional explicit csv_path). See
scripts/DEPLOY_SCRIPTS.md.
EOF
  exit 1
}

CONFIG="${SCRIPT_DIR}/dfx-config.json"
CSV_DIR="./dfx-csv"
TREES_DIR="./dfx-trees"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)    CONFIG="$2"; shift 2 ;;
    --csv-dir)   CSV_DIR="$2"; shift 2 ;;
    --trees-dir) TREES_DIR="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done
export DRY_RUN

preflight "$REPO_ROOT" "$CONFIG"

# Shared top-level settings.
RPC_URL="$(cfg "$CONFIG" '.rpc_url')"
PROGRAM_ID="$(cfg "$CONFIG" '.program_id')"
KEYPAIR_PATH="$(cfg "$CONFIG" '.keypair_path')"
PRIORITY="$(cfg "$CONFIG" '.priority')"
START_VESTING_TS="$(cfg "$CONFIG" '.start_vesting_ts')"
END_VESTING_TS="$(cfg "$CONFIG" '.end_vesting_ts')"
CLAWBACK_START_TS="$(cfg "$CONFIG" '.clawback_start_ts')"
ENABLE_SLOT="$(cfg "$CONFIG" '.enable_slot')"
MAX_NODES_PER_TREE="$(cfg "$CONFIG" '.max_nodes_per_tree')"
CSV_AMOUNT_UNIT="$(cfg "$CONFIG" '.csv_amount_unit')"
CLOSABLE="$(cfg "$CONFIG" '.closable')"
START_AIRDROP_VERSION="$(cfg "$CONFIG" '.start_airdrop_version')"

# Single-mint specifics.
MINT="$(cfg "$CONFIG" '.mint')"
DECIMALS="$(cfg "$CONFIG" '.decimals')"
SYMBOL="$(cfg "$CONFIG" '.symbol')"
CSV_PATH="$(cfg "$CONFIG" '.csv_path')"

[[ -n "$MINT" ]] || { echo "Config missing 'mint': $CONFIG" >&2; exit 1; }
[[ -n "$SYMBOL" ]] || { echo "Config missing 'symbol': $CONFIG" >&2; exit 1; }

# DFX CSV doesn't follow the <index>-<symbol> convention; allow an explicit
# csv_path override, falling back to <csv-dir>/<symbol>.csv.
[[ -n "$CSV_PATH" ]] || CSV_PATH="${CSV_DIR}/${SYMBOL}.csv"
TREE_DIR="${TREES_DIR}/${SYMBOL}"

echo "==> DFX deploy from $CONFIG"
echo "    rpc=$RPC_URL program=$PROGRAM_ID dry-run=$DRY_RUN"
echo

deploy_market \
  "$MINT" "$DECIMALS" "$CSV_PATH" "$TREE_DIR" \
  "$RPC_URL" "$PROGRAM_ID" "$KEYPAIR_PATH" "$PRIORITY" \
  "$MAX_NODES_PER_TREE" "$CSV_AMOUNT_UNIT" "$START_AIRDROP_VERSION" \
  "$START_VESTING_TS" "$END_VESTING_TS" "$CLAWBACK_START_TS" \
  "$ENABLE_SLOT" "$CLOSABLE" "$SYMBOL"

echo
echo "==> Done."
