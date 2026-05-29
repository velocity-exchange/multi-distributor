#!/usr/bin/env bash
set -euo pipefail

# Deploy the single DFX IOU merkle trees + distributor. Kept separate from the
# multi-market IF flow on purpose, but shares deploy_market() so the CLI-call
# sequence never drifts.
#
# Funding (fund-all) and verify are intentionally MANUAL and out of scope.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=scripts/deploy-merkle-trees/deploy-common.sh
source "${SCRIPT_DIR}/deploy-common.sh"

usage() {
  cat <<EOF
Usage: $0 [--config <file>] [--csv-dir <dir>] [--trees-dir <dir>] [--dry-run]

  --config     DFX config JSON (default: scripts/dfx-config.json)
  --csv-dir    Directory for the CSV when csv_path is not set in config.
               Overrides the config's csv_dir; falls back to ./dfx-csv.
               Resolves to <csv-dir>/<symbol>.csv
  --trees-dir  Output directory for trees. Overrides the config's trees_dir;
               falls back to ./dfx-trees. Writes to <trees-dir>/<symbol>/
  --dry-run    Print the CLI commands instead of executing them
  -h, --help   Show this help

The config has the same top-level shared keys as the IF config but a single
mint/decimals/symbol (plus an optional explicit csv_path). See
scripts/DEPLOY_SCRIPTS.md.
EOF
  exit 1
}

CONFIG="${SCRIPT_DIR}/dfx-config.json"
CSV_DIR=""
TREES_DIR=""
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
load_shared_config "$CONFIG"

# Directory precedence: CLI flag > config (csv_dir/trees_dir) > built-in default.
[[ -n "$CSV_DIR" ]]   || CSV_DIR="$(cfg "$CONFIG" '.csv_dir')"
[[ -n "$CSV_DIR" ]]   || CSV_DIR="./dfx-csv"
[[ -n "$TREES_DIR" ]] || TREES_DIR="$(cfg "$CONFIG" '.trees_dir')"
[[ -n "$TREES_DIR" ]] || TREES_DIR="./dfx-trees"

# Single-mint specifics.
MINT="$(cfg "$CONFIG" '.mint')"
DECIMALS="$(cfg "$CONFIG" '.decimals')"
SYMBOL="$(cfg "$CONFIG" '.symbol')"
CSV_PATH="$(cfg "$CONFIG" '.csv_path')"

[[ -n "$MINT" ]] || { echo "Config missing 'mint': $CONFIG" >&2; exit 1; }
[[ -n "$SYMBOL" ]] || { echo "Config missing 'symbol': $CONFIG" >&2; exit 1; }
[[ -n "$DECIMALS" ]] || { echo "Config missing 'decimals': $CONFIG" >&2; exit 1; }

# DFX CSV doesn't follow the <index>-<symbol> convention; allow an explicit
# csv_path override, falling back to <csv-dir>/<symbol>.csv.
[[ -n "$CSV_PATH" ]] || CSV_PATH="${CSV_DIR}/${SYMBOL}.csv"
TREE_DIR="${TREES_DIR}/${SYMBOL}"

echo "==> DFX deploy from $CONFIG"
echo "    rpc=$RPC_URL program=$PROGRAM_ID dry-run=$DRY_RUN"
echo

deploy_market "$MINT" "$DECIMALS" "$CSV_PATH" "$TREE_DIR" "$SYMBOL"

echo
echo "==> Done."
