#!/usr/bin/env bash
set -euo pipefail

# Deploy Insurance Fund (IF) merkle trees + distributors, one per spot market.
# Reads shared deploy settings + a `markets[]` array from a single JSON config,
# then runs create-merkle-tree and new-distributor for each market.
#
# Funding (fund-all) and verify are intentionally MANUAL and out of scope.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/deploy-common.sh
source "${SCRIPT_DIR}/deploy-common.sh"

usage() {
  cat <<EOF
Usage: $0 [--config <file>] [--csv-dir <dir>] [--trees-dir <dir>] [--start-index N] [--dry-run]

  --config       IF config JSON (default: scripts/if-markets.json)
  --csv-dir      Directory holding per-market CSVs (default: ./if-csv)
                 Each market resolves to <csv-dir>/<index>-<symbol>.csv
  --trees-dir    Output directory for trees (default: ./if-trees)
                 Each market writes to <trees-dir>/<index>-<symbol>/
  --start-index  Skip markets whose index < N (resume an interrupted run)
  --dry-run      Print the CLI commands instead of executing them
  -h, --help     Show this help

Shared settings (rpc_url, program_id, keypair_path, vesting timestamps, etc.)
live at the top level of the config; only mint/decimals/index/symbol differ
per market in the markets[] array. See scripts/DEPLOY_SCRIPTS.md.
EOF
  exit 1
}

CONFIG="${SCRIPT_DIR}/if-markets.json"
CSV_DIR="./if-csv"
TREES_DIR="./if-trees"
START_INDEX=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)      CONFIG="$2"; shift 2 ;;
    --csv-dir)     CSV_DIR="$2"; shift 2 ;;
    --trees-dir)   TREES_DIR="$2"; shift 2 ;;
    --start-index) START_INDEX="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage ;;
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

NUM_MARKETS="$(jq '.markets | length' "$CONFIG")"
[[ "$NUM_MARKETS" -gt 0 ]] || { echo "Config has no markets[]: $CONFIG" >&2; exit 1; }

echo "==> IF deploy: $NUM_MARKETS market(s) from $CONFIG"
echo "    rpc=$RPC_URL program=$PROGRAM_ID dry-run=$DRY_RUN"
echo

OK=()
FAIL=()

for ((i = 0; i < NUM_MARKETS; i++)); do
  index="$(jq -r ".markets[$i].index" "$CONFIG")"
  symbol="$(jq -r ".markets[$i].symbol" "$CONFIG")"
  mint="$(jq -r ".markets[$i].mint" "$CONFIG")"
  decimals="$(jq -r ".markets[$i].decimals" "$CONFIG")"

  if [[ -n "$START_INDEX" && "$index" -lt "$START_INDEX" ]]; then
    echo "==> [${index}-${symbol}] skipped (< start-index $START_INDEX)"
    continue
  fi

  label="${index}-${symbol}"
  csv_path="${CSV_DIR}/${label}.csv"
  tree_dir="${TREES_DIR}/${label}"

  if deploy_market \
      "$mint" "$decimals" "$csv_path" "$tree_dir" \
      "$RPC_URL" "$PROGRAM_ID" "$KEYPAIR_PATH" "$PRIORITY" \
      "$MAX_NODES_PER_TREE" "$CSV_AMOUNT_UNIT" "$START_AIRDROP_VERSION" \
      "$START_VESTING_TS" "$END_VESTING_TS" "$CLAWBACK_START_TS" \
      "$ENABLE_SLOT" "$CLOSABLE" "$label"; then
    OK+=("$label")
  else
    FAIL+=("$label")
  fi
  echo
done

echo "==> Summary"
echo "    succeeded (${#OK[@]}): ${OK[*]:-<none>}"
echo "    failed    (${#FAIL[@]}): ${FAIL[*]:-<none>}"
[[ ${#FAIL[@]} -eq 0 ]] || exit 1
