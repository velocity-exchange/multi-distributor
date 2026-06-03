#!/usr/bin/env bash
# Shared helpers for deploy-if.sh and deploy-dfx.sh.
# This file is sourced, not executed; it intentionally has no `set` flags of
# its own (the sourcing entry script owns `set -euo pipefail`).

# ---------------------------------------------------------------------------
# cli path resolver: prefer the release build, fall back to debug.
# Sets the global CLI variable. Exits non-zero if neither exists.
# ---------------------------------------------------------------------------
resolve_cli() {
  local root="$1"
  if [[ -x "${root}/target/release/cli" ]]; then
    CLI="${root}/target/release/cli"
  elif [[ -x "${root}/target/debug/cli" ]]; then
    CLI="${root}/target/debug/cli"
  else
    echo "Missing cli binary: build it first with 'cargo build' (looked for" >&2
    echo "  ${root}/target/release/cli and ${root}/target/debug/cli)." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Preflight checks shared by both entry scripts.
#   $1 = repo root, $2 = config file path
# Resolves CLI as a side effect.
# ---------------------------------------------------------------------------
preflight() {
  local root="$1" config="$2"
  command -v jq >/dev/null || { echo "Missing required binary: jq" >&2; exit 1; }
  [[ -f "$config" ]] || { echo "Config not found: $config" >&2; exit 1; }
  jq -e . "$config" >/dev/null 2>&1 || { echo "Config is not valid JSON: $config" >&2; exit 1; }
  resolve_cli "$root"
}

# ---------------------------------------------------------------------------
# jq config readers.
#   cfg <config> <jq-filter>          -> raw value ("" if null/absent)
# ---------------------------------------------------------------------------
cfg() {
  local config="$1" filter="$2"
  jq -r "${filter} // empty" "$config"
}

# ---------------------------------------------------------------------------
# Read shared top-level deploy settings from the config into the globals that
# deploy_market consumes. Both entry scripts call this so the shared-key list
# lives in exactly one place. Sets: RPC_URL PROGRAM_ID KEYPAIR_PATH PRIORITY
# START_VESTING_TS END_VESTING_TS CLAWBACK_START_TS ENABLE_SLOT
# MAX_NODES_PER_TREE CLOSABLE START_AIRDROP_VERSION.
# ---------------------------------------------------------------------------
load_shared_config() {
  local config="$1"
  RPC_URL="$(cfg "$config" '.rpc_url')"
  PROGRAM_ID="$(cfg "$config" '.program_id')"
  KEYPAIR_PATH="$(cfg "$config" '.keypair_path')"
  PRIORITY="$(cfg "$config" '.priority')"
  START_VESTING_TS="$(cfg "$config" '.start_vesting_ts')"
  END_VESTING_TS="$(cfg "$config" '.end_vesting_ts')"
  CLAWBACK_START_TS="$(cfg "$config" '.clawback_start_ts')"
  ENABLE_SLOT="$(cfg "$config" '.enable_slot')"
  MAX_NODES_PER_TREE="$(cfg "$config" '.max_nodes_per_tree')"
  CLOSABLE="$(cfg "$config" '.closable')"
  START_AIRDROP_VERSION="$(cfg "$config" '.start_airdrop_version')"

  # The cli (and solana's read_keypair_file) does not expand ~; do it here so a
  # leading-tilde keypair_path works.
  KEYPAIR_PATH="${KEYPAIR_PATH/#\~/$HOME}"

  # Fail fast (in preflight, not mid-deploy) if a required shared key is missing.
  # priority/closable are optional; start_airdrop_version falls back to the
  # cli's own default and is passed conditionally by deploy_market.
  local missing=()
  [[ -n "$RPC_URL" ]]            || missing+=(rpc_url)
  [[ -n "$PROGRAM_ID" ]]         || missing+=(program_id)
  [[ -n "$KEYPAIR_PATH" ]]       || missing+=(keypair_path)
  [[ -n "$MAX_NODES_PER_TREE" ]] || missing+=(max_nodes_per_tree)
  [[ -n "$START_VESTING_TS" ]]   || missing+=(start_vesting_ts)
  [[ -n "$END_VESTING_TS" ]]     || missing+=(end_vesting_ts)
  [[ -n "$CLAWBACK_START_TS" ]]  || missing+=(clawback_start_ts)
  [[ -n "$ENABLE_SLOT" ]]        || missing+=(enable_slot)
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Config missing required key(s): ${missing[*]}" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Deploy a single market: generate trees, then create distributor(s).
# The per-market specifics are positional args; the shared deploy settings are
# read from the globals set by load_shared_config, so the logic lives in
# exactly one place and never drifts between the two scripts.
#
# Positional args:
#   1  mint
#   2  csv_path
#   3  tree_dir
#   4  label                 (for log lines, e.g. "0-USDC")
#
# Trees are always generated in base-unit mode (--csv-amount-unit tokens with
# --decimals 0), so each CSV integer is the exact on-chain claim amount with no
# scaling and no rounding. Both IF and DFX entitlements are sourced as token
# base units, so the CSV carries raw base units, not UI token amounts.
#
# Honors DRY_RUN: when "1", prints the commands instead of running them.
# In non-dry-run mode the CSV must exist; under dry-run it's only warned about.
# ---------------------------------------------------------------------------
deploy_market() {
  local mint="$1" csv_path="$2" tree_dir="$3" label="$4"
  local rpc_url="$RPC_URL" program_id="$PROGRAM_ID" keypair_path="$KEYPAIR_PATH"
  local priority="$PRIORITY" max_nodes_per_tree="$MAX_NODES_PER_TREE"
  local start_airdrop_version="$START_AIRDROP_VERSION"
  local start_vesting_ts="$START_VESTING_TS" end_vesting_ts="$END_VESTING_TS"
  local clawback_start_ts="$CLAWBACK_START_TS" enable_slot="$ENABLE_SLOT" closable="$CLOSABLE"

  echo "==> [$label] mint=$mint (base units)"
  echo "    csv:   $csv_path"
  echo "    trees: $tree_dir"

  if [[ ! -f "$csv_path" ]]; then
    if [[ "${DRY_RUN:-0}" == "1" ]]; then
      echo "    WARNING: CSV not found (dry-run, continuing): $csv_path" >&2
    else
      echo "    ERROR: CSV not found: $csv_path" >&2
      return 1
    fi
  fi

  # Build conditional global/subcommand flags. start_airdrop_version is omitted
  # when unset so the cli auto-detects the next available version instead of
  # receiving an empty arg.
  local -a priority_flag=()
  [[ -n "$priority" ]] && priority_flag=(--priority "$priority")
  local -a closable_flag=()
  [[ "$closable" == "true" ]] && closable_flag=(--closable)
  local -a start_ver_flag=()
  [[ -n "$start_airdrop_version" ]] && start_ver_flag=(--start-airdrop-version "$start_airdrop_version")

  # 1. generate trees. --csv-amount-unit tokens with --decimals 0 means the CSV
  # integer passes through to base units unchanged (scale = 10^0 = 1).
  local -a gen=(
    "$CLI"
    --mint "$mint"
    --rpc-url "$rpc_url"
    --program-id "$program_id"
    --keypair-path "$keypair_path"
    ${priority_flag[@]+"${priority_flag[@]}"}
    create-merkle-tree
    --csv-path "$csv_path"
    --merkle-tree-path "$tree_dir"
    --max-nodes-per-tree "$max_nodes_per_tree"
    --amount 0
    --decimals 0
    --csv-amount-unit tokens
    ${start_ver_flag[@]+"${start_ver_flag[@]}"}
  )

  # 2. create distributor(s) for the generated trees
  local -a dist=(
    "$CLI"
    --mint "$mint"
    --rpc-url "$rpc_url"
    --program-id "$program_id"
    --keypair-path "$keypair_path"
    ${priority_flag[@]+"${priority_flag[@]}"}
    new-distributor
    --start-vesting-ts "$start_vesting_ts"
    --end-vesting-ts "$end_vesting_ts"
    --merkle-tree-path "$tree_dir"
    --clawback-start-ts "$clawback_start_ts"
    --enable-slot "$enable_slot"
    ${closable_flag[@]+"${closable_flag[@]}"}
  )

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "    [dry-run] create-merkle-tree:"
    printf '     '; printf ' %q' "${gen[@]}"; echo
    echo "    [dry-run] new-distributor:"
    printf '     '; printf ' %q' "${dist[@]}"; echo
    return 0
  fi

  mkdir -p "$tree_dir"
  echo "    -> generating merkle trees"
  "${gen[@]}"
  echo "    -> creating distributor(s)"
  "${dist[@]}"
}

# ---------------------------------------------------------------------------
# Fund a single market's distributor vault(s) from the funder's token account.
# Runs `fund-all` against an already-generated trees dir: the cli iterates the
# tree JSONs, and for each transfers max_total_claim from the funder's ATA
# (ATA(keypair, mint)) into that tree's distributor vault. It is idempotent —
# the cli skips any vault already funded to max_total_claim.
#
# The funder keypair must already hold the mint's tokens; for IF each market is
# a distinct mint, so the funder needs a funded ATA per mint. Trees must exist
# (run deploy first).
#
# Positional args:
#   1  mint
#   2  tree_dir
#   3  label                 (for log lines, e.g. "0-USDC")
#
# Reads RPC_URL/PROGRAM_ID/KEYPAIR_PATH/PRIORITY from load_shared_config.
# Honors DRY_RUN: when "1", prints the command instead of running it. In
# non-dry-run mode the trees dir must exist; under dry-run it's only warned.
# ---------------------------------------------------------------------------
fund_market() {
  local mint="$1" tree_dir="$2" label="$3"
  local rpc_url="$RPC_URL" program_id="$PROGRAM_ID" keypair_path="$KEYPAIR_PATH"
  local priority="$PRIORITY"

  echo "==> [$label] fund mint=$mint"
  echo "    trees: $tree_dir"

  if [[ ! -d "$tree_dir" ]]; then
    if [[ "${DRY_RUN:-0}" == "1" ]]; then
      echo "    WARNING: trees dir not found (dry-run, continuing): $tree_dir" >&2
    else
      echo "    ERROR: trees dir not found (generate trees first): $tree_dir" >&2
      return 1
    fi
  fi

  local -a priority_flag=()
  [[ -n "$priority" ]] && priority_flag=(--priority "$priority")

  local -a fund=(
    "$CLI"
    --mint "$mint"
    --rpc-url "$rpc_url"
    --program-id "$program_id"
    --keypair-path "$keypair_path"
    ${priority_flag[@]+"${priority_flag[@]}"}
    fund-all
    --merkle-tree-path "$tree_dir"
  )

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "    [dry-run] fund-all:"
    printf '     '; printf ' %q' "${fund[@]}"; echo
    return 0
  fi

  echo "    -> funding distributor vault(s)"
  "${fund[@]}"
}

# ---------------------------------------------------------------------------
# Collapse same-mint IF markets into one CSV + one config entry per unique mint,
# by running the cli's `aggregate-if-csvs` subcommand.
#
# Spot markets are NOT guaranteed to have unique mints (e.g. several USDC
# markets). A claimant with entitlements in two same-mint markets must claim
# their *combined* total once, from a single distributor — not once per market
# (which would also collide on the per-mint distributor version). This sums each
# claimant's amount AND locked_amount across same-mint markets and writes:
#   <processed_dir>/<index>-<symbol>.csv   one deduped CSV per unique mint
#   <processed_dir>/merged-config.json     the config with markets[] collapsed
#                                          and csv_dir repointed at processed_dir
#
# Deterministic and idempotent: re-running rewrites identical files, and with
# all-unique mints it is a pass-through (one entry per mint already). Artifacts
# are kept (never deleted) so merged-config.json is an auditable record of
# exactly what was deployed, and fund-if.sh reuses it.
#
# Sets the global MERGED_CONFIG to the written merged-config.json path.
#
# Positional args:
#   1  config        source IF config
#   2  csv_dir        where per-market CSVs live (<index>-<symbol>.csv)
#   3  processed_dir  output dir for merged CSVs + merged-config.json
# ---------------------------------------------------------------------------
aggregate_if() {
  local config="$1" csv_dir="$2" processed_dir="$3"
  MERGED_CONFIG="${processed_dir}/merged-config.json"

  echo "==> aggregating same-mint markets by mint"
  echo "    source csv:    $csv_dir"
  echo "    processed dir: $processed_dir"
  echo "    merged config: $MERGED_CONFIG"

  mkdir -p "$processed_dir"
  "$CLI" aggregate-if-csvs \
    --config "$config" \
    --csv-dir "$csv_dir" \
    --out-csv-dir "$processed_dir" \
    --out-config "$MERGED_CONFIG"
}
