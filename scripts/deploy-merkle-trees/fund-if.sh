#!/usr/bin/env bash
set -euo pipefail

# Fund the Insurance Fund (IF) distributor vaults, one per spot market. Reads
# the same JSON config + markets[] array as deploy-if.sh, then runs fund-all
# against each market's already-generated trees dir.
#
# The funder keypair must already hold each market mint's tokens (each market
# is a distinct mint). Trees must exist first (run deploy-if.sh). Funding is
# idempotent: the cli skips vaults already funded to max_total_claim.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=scripts/deploy-merkle-trees/deploy-common.sh
source "${SCRIPT_DIR}/deploy-common.sh"

usage() {
  cat <<EOF
Usage: $0 [--config <file>] [--trees-dir <dir>] [--start-index N] [--dry-run]

  --config       IF config JSON (default: scripts/if-markets.json)
  --trees-dir    Directory holding the per-market trees. Overrides the config's
                 trees_dir; falls back to ./if-trees if neither is set.
                 Each market reads from <trees-dir>/<index>-<symbol>/
  --start-index  Skip markets whose index < N (resume an interrupted run)
  --dry-run      Print the CLI commands instead of executing them
  -h, --help     Show this help

Uses the same shared settings (rpc_url, program_id, keypair_path, priority) and
markets[] array as deploy-if.sh. Funding only needs the trees dir — no CSVs,
vesting timestamps, or max_nodes. See
scripts/deploy-merkle-trees/deploy-merkle-trees.md.
EOF
  exit 1
}

CONFIG="${SCRIPT_DIR}/if-markets.json"
TREES_DIR=""
START_INDEX=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)      CONFIG="$2"; shift 2 ;;
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

# Directory precedence: CLI flag > config (trees_dir) > built-in default.
[[ -n "$TREES_DIR" ]] || TREES_DIR="$(cfg "$CONFIG" '.trees_dir')"
[[ -n "$TREES_DIR" ]] || TREES_DIR="./if-trees"

NUM_MARKETS="$(jq '.markets | length' "$CONFIG")"
[[ "$NUM_MARKETS" -gt 0 ]] || { echo "Config has no markets[]: $CONFIG" >&2; exit 1; }

echo "==> IF fund: $NUM_MARKETS market(s) from $CONFIG"
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
  tree_dir="${TREES_DIR}/${label}"

  if fund_market "$mint" "$tree_dir" "$label"; then
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
