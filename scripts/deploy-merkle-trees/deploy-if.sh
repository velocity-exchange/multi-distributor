#!/usr/bin/env bash
set -euo pipefail

# Deploy Insurance Fund (IF) merkle trees + distributors, one per spot market.
# Reads shared deploy settings + a `markets[]` array from a single JSON config,
# then runs create-merkle-tree and new-distributor for each market.
#
# Funding (fund-all) and verify are intentionally MANUAL and out of scope.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=scripts/deploy-merkle-trees/deploy-common.sh
source "${SCRIPT_DIR}/deploy-common.sh"

usage() {
  cat <<EOF
Usage: $0 [--config <file>] [--csv-dir <dir>] [--trees-dir <dir>] [--start-index N] [--dry-run]

  --config       IF config JSON (default: scripts/if-markets.json)
  --csv-dir      Directory holding per-market CSVs. Overrides the config's
                 csv_dir; falls back to ./if-csv if neither is set.
                 Each market resolves to <csv-dir>/<index>-<symbol>.csv
  --trees-dir    Output directory for trees. Overrides the config's trees_dir;
                 falls back to ./if-trees if neither is set.
                 Each market writes to <trees-dir>/<index>-<symbol>/
  --start-index  Skip markets whose index < N (resume an interrupted run)
  --dry-run      Print the CLI commands instead of executing them
  -h, --help     Show this help

Shared settings (rpc_url, program_id, keypair_path, vesting timestamps, etc.)
live at the top level of the config; only index/symbol/mint differ per market
in the markets[] array. IF CSVs carry raw on-chain base units, so trees are
generated in base-unit mode (no per-market decimals needed). See
scripts/deploy-merkle-trees/deploy-merkle-trees.md.
EOF
  exit 1
}

CONFIG="${SCRIPT_DIR}/if-markets.json"
CSV_DIR=""
TREES_DIR=""
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
load_shared_config "$CONFIG"

# IF entitlements come straight from on-chain Insurance Fund balances, which are
# already token base units. Generate trees in base-unit mode (--csv-amount-unit
# tokens with --decimals 0) so each CSV integer is the exact on-chain claim
# amount, with no scaling and no rounding. This is fixed for IF rather than
# config-driven, so the deploy can't be put into a lossy mode (e.g. cents) by
# mistake. The CSV therefore carries raw base units, not UI token amounts.
CSV_AMOUNT_UNIT="tokens"
IF_DECIMALS=0

# Directory precedence: CLI flag > config (csv_dir/trees_dir) > built-in default.
[[ -n "$CSV_DIR" ]]   || CSV_DIR="$(cfg "$CONFIG" '.csv_dir')"
[[ -n "$CSV_DIR" ]]   || CSV_DIR="./if-csv"
[[ -n "$TREES_DIR" ]] || TREES_DIR="$(cfg "$CONFIG" '.trees_dir')"
[[ -n "$TREES_DIR" ]] || TREES_DIR="./if-trees"

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

  # jq prints "null" for an absent field; reject incomplete entries up front so
  # the start-index arithmetic and the cli call don't choke on a bad value.
  for field in index symbol mint; do
    val="${!field}"
    if [[ -z "$val" || "$val" == "null" ]]; then
      echo "==> markets[$i] missing '$field'; skipping" >&2
      FAIL+=("markets[$i]")
      continue 2
    fi
  done

  if [[ -n "$START_INDEX" && "$index" -lt "$START_INDEX" ]]; then
    echo "==> [${index}-${symbol}] skipped (< start-index $START_INDEX)"
    continue
  fi

  label="${index}-${symbol}"
  csv_path="${CSV_DIR}/${label}.csv"
  tree_dir="${TREES_DIR}/${label}"

  if deploy_market "$mint" "$IF_DECIMALS" "$csv_path" "$tree_dir" "$label"; then
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
