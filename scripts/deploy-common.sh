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
# Deploy a single market: generate trees, then create distributor(s).
# All inputs are passed as named env-style locals via positional args so the
# logic lives in exactly one place and never drifts between the two scripts.
#
# Positional args:
#   1  mint
#   2  decimals
#   3  csv_path
#   4  tree_dir
#   5  rpc_url
#   6  program_id
#   7  keypair_path
#   8  priority              (may be empty)
#   9  max_nodes_per_tree
#  10  csv_amount_unit
#  11  start_airdrop_version
#  12  start_vesting_ts
#  13  end_vesting_ts
#  14  clawback_start_ts
#  15  enable_slot
#  16  closable              ("true" => pass --closable)
#  17  label                 (for log lines, e.g. "0-USDC")
#
# Honors DRY_RUN: when "1", prints the commands instead of running them.
# In non-dry-run mode the CSV must exist; under dry-run it's only warned about.
# ---------------------------------------------------------------------------
deploy_market() {
  local mint="$1" decimals="$2" csv_path="$3" tree_dir="$4"
  local rpc_url="$5" program_id="$6" keypair_path="$7" priority="$8"
  local max_nodes_per_tree="$9" csv_amount_unit="${10}" start_airdrop_version="${11}"
  local start_vesting_ts="${12}" end_vesting_ts="${13}" clawback_start_ts="${14}"
  local enable_slot="${15}" closable="${16}" label="${17}"

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
