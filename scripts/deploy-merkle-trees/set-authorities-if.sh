#!/usr/bin/env bash
set -euo pipefail

# Hand the Insurance Fund (IF) distributors over to the multisig: set every
# distributor's clawback_receiver and admin to the main multisig vault. Reads
# the same JSON config + markets[] as deploy-if.sh / fund-if.sh and operates on
# the SAME by-mint merged view (one distributor per unique mint).
#
# This is signed by the CURRENT admin (the deploy keypair, config.keypair_path),
# NOT the multisig — it is the one-way handover that makes the multisig the
# admin. After it runs, only the multisig can change these distributors (use
# msig-fund/ + the Squads UI for anything admin-gated). It is therefore the LAST
# step: deploy -> fund -> verify -> set-authorities.
#
# Ordering is enforced and matters:
#   1. clawback_receiver first (set_clawback_receiver requires the current admin
#      to sign, and needs an existing ATA(receiver, mint) — created here if
#      missing),
#   2. admin last (after this, the current keypair can no longer administer).
# All clawback receivers are set across every selected market BEFORE any admin
# is handed over, so an interrupted run never strands a market with its admin
# moved but its clawback receiver not yet set.
#
# Both set-admin and set-clawback-receiver are idempotent (the cli skips a
# distributor already pointing at the target), so re-running is safe.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
# shellcheck source=scripts/deploy-merkle-trees/deploy-common.sh
source "${SCRIPT_DIR}/deploy-common.sh"

# Main multisig vault (Squads multisig 7qipzLR9..., vault index 0). Both the new
# admin and the clawback receiver owner default to this.
DEFAULT_VAULT="8jj7zJgdr5bDndc7evM74FMGwzLPmd4u4QxNzFi1BMai"

usage() {
  cat <<EOF
Usage: $0 [--config <file>] [--admin <pubkey>] [--clawback-receiver <pubkey>]
          [--csv-dir <dir>] [--trees-dir <dir>] [--market <symbol> | --index N]
          [--start-index N] [--dry-run]

  --config             IF config JSON (default: scripts/if-markets.json)
  --admin              New admin pubkey       (default: $DEFAULT_VAULT)
  --clawback-receiver  Clawback receiver owner (default: $DEFAULT_VAULT)
                       The on-chain clawback_receiver is ATA(owner, mint); the
                       ATA is created here if it does not exist yet.
  --csv-dir            Base CSV directory. Flag > config csv_dir > ./if-csv.
                       Reuses <csv-dir>/processed/merged-config.json from deploy.
  --trees-dir          Trees dir. Flag > config trees_dir > ./if-trees.
  --market <symbol>    Only this market (e.g. mSOL). Mutually exclusive w/ --index.
  --index <n>          Only this market index (e.g. 2).
  --start-index N      Skip markets whose index < N (resume an interrupted run).
  --dry-run            Print the cli/spl-token commands instead of executing them.
  -h, --help           Show this help

Operates on the by-mint merged view (merged-config.json) deploy-if.sh wrote, so
the distributors line up one-to-one with what was deployed. See
scripts/deploy-merkle-trees/deploy-merkle-trees.md.
EOF
  exit 1
}

CONFIG="${SCRIPT_DIR}/if-markets.json"
NEW_ADMIN="$DEFAULT_VAULT"
CLAWBACK_OWNER="$DEFAULT_VAULT"
CSV_DIR=""
TREES_DIR=""
ONLY_SYMBOL=""
ONLY_INDEX=""
START_INDEX=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)             CONFIG="$2"; shift 2 ;;
    --admin)              NEW_ADMIN="$2"; shift 2 ;;
    --clawback-receiver)  CLAWBACK_OWNER="$2"; shift 2 ;;
    --csv-dir)            CSV_DIR="$2"; shift 2 ;;
    --trees-dir)          TREES_DIR="$2"; shift 2 ;;
    --market)             ONLY_SYMBOL="$2"; shift 2 ;;
    --index)              ONLY_INDEX="$2"; shift 2 ;;
    --start-index)        START_INDEX="$2"; shift 2 ;;
    --dry-run)            DRY_RUN=1; shift ;;
    -h|--help)            usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done
export DRY_RUN

[[ -z "$ONLY_SYMBOL" || -z "$ONLY_INDEX" ]] || {
  echo "--market and --index are mutually exclusive" >&2; exit 1; }

command -v spl-token >/dev/null || { echo "Missing required binary: spl-token" >&2; exit 1; }
command -v solana    >/dev/null || { echo "Missing required binary: solana" >&2; exit 1; }

preflight "$REPO_ROOT" "$CONFIG"
load_shared_config "$CONFIG"

# Directory precedence: CLI flag > config > built-in default.
[[ -n "$CSV_DIR" ]]   || CSV_DIR="$(cfg "$CONFIG" '.csv_dir')"
[[ -n "$CSV_DIR" ]]   || CSV_DIR="./if-csv"
[[ -n "$TREES_DIR" ]] || TREES_DIR="$(cfg "$CONFIG" '.trees_dir')"
[[ -n "$TREES_DIR" ]] || TREES_DIR="./if-trees"

RAW_CSV_DIR="${CSV_DIR}/raw"
PROCESSED_CSV_DIR="${CSV_DIR}/processed"

# Reuse the same merged-by-mint config deploy/fund used; regenerate only if absent.
MERGED_CONFIG="${PROCESSED_CSV_DIR}/merged-config.json"
if [[ -f "$MERGED_CONFIG" ]]; then
  echo "==> reusing merged config: $MERGED_CONFIG"
else
  echo "==> merged config not found; regenerating from source CSVs"
  aggregate_if "$CONFIG" "$RAW_CSV_DIR" "$PROCESSED_CSV_DIR"
fi
MCONFIG="$MERGED_CONFIG"
echo

ADMIN_PUBKEY="$(solana-keygen pubkey "$KEYPAIR_PATH" 2>/dev/null || echo '<unreadable>')"

echo "==> IF set-authorities (admin handover)"
echo "    rpc            $RPC_URL"
echo "    program        $PROGRAM_ID"
echo "    signer (admin) $ADMIN_PUBKEY   ($KEYPAIR_PATH)"
echo "    new admin      $NEW_ADMIN"
echo "    clawback owner $CLAWBACK_OWNER  (receiver = ATA(owner, mint))"
echo "    dry-run        $DRY_RUN"
echo

# Build the selected market list as "index<TAB>symbol<TAB>mint" lines (bash 3.2
# compatible — no mapfile).
MARKETS=()
while IFS= read -r line; do
  MARKETS+=("$line")
done < <(jq -r '.markets[] | "\(.index)\t\(.symbol)\t\(.mint)"' "$MCONFIG")

lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

select_market() {
  # filters by --index / --market / --start-index, then config exclude_markets
  # and empty CSVs; echoes "keep" or "skip".
  local index="$1" symbol="$2"
  if [[ -n "$ONLY_INDEX" ]]; then
    [[ "$index" == "$ONLY_INDEX" ]] || { echo skip; return; }
  elif [[ -n "$ONLY_SYMBOL" ]]; then
    [[ "$(lc "$symbol")" == "$(lc "$ONLY_SYMBOL")" ]] || { echo skip; return; }
  elif [[ -n "$START_INDEX" && "$index" -lt "$START_INDEX" ]]; then
    echo skip; return
  fi
  # Skip the same markets deploy skipped: config exclusions + 0-claim CSVs, so
  # we never create a clawback ATA or set-admin on a non-existent distributor.
  if market_excluded "$index"; then echo skip; return; fi
  local csv="${PROCESSED_CSV_DIR}/${index}-${symbol}.csv"
  if [[ -f "$csv" ]] && ! csv_has_claims "$csv"; then echo skip; return; fi
  echo keep
}

# Shared global-flag prefix for the cli (mirrors deploy_market).
cli_prefix() {
  local mint="$1"
  CLI_ARGS=("$CLI" --mint "$mint" --rpc-url "$RPC_URL" --program-id "$PROGRAM_ID" \
            --keypair-path "$KEYPAIR_PATH")
  if [[ -n "$PRIORITY" ]]; then CLI_ARGS+=(--priority "$PRIORITY"); fi
}

# Ensure ATA(owner, mint) exists (set_clawback_receiver needs an existing token
# account). Idempotent: derives the ATA, creates it only when missing.
ensure_ata() {
  local owner="$1" mint="$2"
  local ata
  ata="$(spl-token address --token "$mint" --owner "$owner" --url "$RPC_URL" \
         --verbose --output json 2>/dev/null | jq -r '.associatedTokenAddress // empty')"
  if [[ -z "$ata" ]]; then
    echo "    ERROR: could not derive ATA for owner=$owner mint=$mint" >&2
    return 1
  fi
  if solana account "$ata" --url "$RPC_URL" --output json >/dev/null 2>&1; then
    echo "    clawback ATA exists: $ata"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    [dry-run] create ATA $ata:"
    echo "       spl-token create-account $mint --owner $owner --fee-payer $KEYPAIR_PATH --url $RPC_URL"
    return 0
  fi
  echo "    creating clawback ATA: $ata"
  spl-token create-account "$mint" --owner "$owner" --fee-payer "$KEYPAIR_PATH" --url "$RPC_URL"
}

run_cli() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '    [dry-run]'; printf ' %q' "$@"; echo
    return 0
  fi
  "$@"
}

OK_CLAWBACK=(); OK_ADMIN=(); FAIL=()

# --- Pass 1: clawback receivers (+ ATA creation) -------------------------------
echo "==> Pass 1/2: set clawback receivers"
for row in "${MARKETS[@]}"; do
  IFS=$'\t' read -r index symbol mint <<<"$row"
  [[ "$(select_market "$index" "$symbol")" == keep ]] || continue
  label="${index}-${symbol}"
  tree_dir="${TREES_DIR}/${label}"
  echo "==> [$label] mint=$mint"
  if [[ ! -d "$tree_dir" && "$DRY_RUN" != "1" ]]; then
    echo "    ERROR: trees dir not found (deploy first): $tree_dir" >&2
    FAIL+=("$label:clawback"); continue
  fi
  if ! ensure_ata "$CLAWBACK_OWNER" "$mint"; then FAIL+=("$label:ata"); continue; fi
  cli_prefix "$mint"
  if run_cli "${CLI_ARGS[@]}" set-clawback-receiver \
       --merkle-tree-path "$tree_dir" --receiver "$CLAWBACK_OWNER"; then
    OK_CLAWBACK+=("$label")
  else
    FAIL+=("$label:clawback")
  fi
  echo
done

# Abort before touching admin if any clawback step failed — handing over admin
# now would lock us out of fixing the failed market's clawback receiver.
if [[ ${#FAIL[@]} -gt 0 ]]; then
  echo "==> Aborting before admin handover; clawback step(s) failed: ${FAIL[*]}" >&2
  echo "    (no admin was changed — fix the above and re-run)" >&2
  exit 1
fi

# --- Pass 2: admins (one-way handover) ----------------------------------------
echo "==> Pass 2/2: set admins -> $NEW_ADMIN"
for row in "${MARKETS[@]}"; do
  IFS=$'\t' read -r index symbol mint <<<"$row"
  [[ "$(select_market "$index" "$symbol")" == keep ]] || continue
  label="${index}-${symbol}"
  tree_dir="${TREES_DIR}/${label}"
  echo "==> [$label] mint=$mint"
  cli_prefix "$mint"
  if run_cli "${CLI_ARGS[@]}" set-admin \
       --new-admin "$NEW_ADMIN" --merkle-tree-path "$tree_dir"; then
    OK_ADMIN+=("$label")
  else
    FAIL+=("$label:admin")
  fi
  echo
done

echo "==> Summary"
echo "    clawback set (${#OK_CLAWBACK[@]}): ${OK_CLAWBACK[*]:-<none>}"
echo "    admin set    (${#OK_ADMIN[@]}): ${OK_ADMIN[*]:-<none>}"
echo "    failed       (${#FAIL[@]}): ${FAIL[*]:-<none>}"
[[ ${#FAIL[@]} -eq 0 ]] || exit 1
