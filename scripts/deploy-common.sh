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
# MAX_NODES_PER_TREE CSV_AMOUNT_UNIT CLOSABLE START_AIRDROP_VERSION.
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
  CSV_AMOUNT_UNIT="$(cfg "$config" '.csv_amount_unit')"
  CLOSABLE="$(cfg "$config" '.closable')"
  START_AIRDROP_VERSION="$(cfg "$config" '.start_airdrop_version')"
}

# ---------------------------------------------------------------------------
# Deploy a single market: generate trees, then create distributor(s).
# The per-market specifics are positional args; the shared deploy settings are
# read from the globals set by load_shared_config, so the logic lives in
# exactly one place and never drifts between the two scripts.
#
# Positional args:
#   1  mint
#   2  decimals
#   3  csv_path
#   4  tree_dir
#   5  label                 (for log lines, e.g. "0-USDC")
#
# Honors DRY_RUN: when "1", prints the commands instead of running them.
# In non-dry-run mode the CSV must exist; under dry-run it's only warned about.
# ---------------------------------------------------------------------------
deploy_market() {
  local mint="$1" decimals="$2" csv_path="$3" tree_dir="$4" label="$5"
  local rpc_url="$RPC_URL" program_id="$PROGRAM_ID" keypair_path="$KEYPAIR_PATH"
  local priority="$PRIORITY" max_nodes_per_tree="$MAX_NODES_PER_TREE"
  local csv_amount_unit="$CSV_AMOUNT_UNIT" start_airdrop_version="$START_AIRDROP_VERSION"
  local start_vesting_ts="$START_VESTING_TS" end_vesting_ts="$END_VESTING_TS"
  local clawback_start_ts="$CLAWBACK_START_TS" enable_slot="$ENABLE_SLOT" closable="$CLOSABLE"

  echo "==> [$label] mint=$mint decimals=$decimals"
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

  # Build conditional global/subcommand flags.
  local -a priority_flag=()
  [[ -n "$priority" ]] && priority_flag=(--priority "$priority")
  local -a closable_flag=()
  [[ "$closable" == "true" ]] && closable_flag=(--closable)

  # 1. generate trees
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
    --decimals "$decimals"
    --csv-amount-unit "$csv_amount_unit"
    --start-airdrop-version "$start_airdrop_version"
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
    printf '      %q' "${gen[@]}"; echo
    echo "    [dry-run] new-distributor:"
    printf '      %q' "${dist[@]}"; echo
    return 0
  fi

  mkdir -p "$tree_dir"
  echo "    -> generating merkle trees"
  "${gen[@]}"
  echo "    -> creating distributor(s)"
  "${dist[@]}"
}
