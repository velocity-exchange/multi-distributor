# Merkle-tree deploy scripts

Config-driven wrappers around the `cli` binary that generate merkle trees and
create on-chain distributors. Two entry points share one helper so the
CLI-call sequence never drifts:

- [`deploy-if.sh`](./deploy-if.sh) — Insurance Fund (IF): many merkle trees
  across many mints, one per spot market index (~63 markets).
- [`deploy-dfx.sh`](./deploy-dfx.sh) — the single DFX IOU mint.
- [`deploy-common.sh`](./deploy-common.sh) — sourced by both; holds preflight
  checks, the `cli` path resolver, jq config readers, and the single
  `deploy_market()` function.

## Scope

Each script does two steps per market:

1. `create-merkle-tree` — generate the sharded trees from the CSV.
2. `new-distributor` — create the on-chain distributor(s) for those trees.

**Out of scope (run manually):** funding the vaults (`fund-all`), the `verify`
step, and generating the input CSVs. See [`DEPLOY.md`](../DEPLOY.md).

## Prerequisites

- `jq` on `PATH`.
- The `cli` binary built: `cargo build` (debug) or `cargo build --release`.
  The scripts prefer `target/release/cli`, falling back to `target/debug/cli`.
- The per-market input CSVs already generated (see
  [`MERKLE_TREES.md`](../MERKLE_TREES.md) for the CSV shape).

## Config files

One JSON file drives a deploy. Shared deploy settings live at the top level;
the per-market fields differ per market (IF: index/symbol/mint; DFX: a single
mint/symbol).

Copy an example, fill it in, and keep the real file out of git (the real names
`scripts/if-markets.json` and `scripts/dfx-config.json` are gitignored):

```bash
cp scripts/if-markets.example.json scripts/if-markets.json
cp scripts/dfx-config.example.json scripts/dfx-config.json
```

Shared top-level keys (both configs):

| Key | Notes |
|---|---|
| `rpc_url` | Solana RPC URL. |
| `program_id` | Distributor program id. |
| `keypair_path` | Admin/payer keypair. A leading `~` is expanded to `$HOME`. |
| `priority` | Priority fee (microlamports), or `null` to omit `--priority`. |
| `start_vesting_ts` / `end_vesting_ts` | Vesting window (contract requires start < end). |
| `clawback_start_ts` | Clawback period start. |
| `enable_slot` | Claim-open slot, or `0` for immediate. |
| `max_nodes_per_tree` | Tree sharding size (e.g. `10000`). |
| `closable` | Boolean; `true` passes `--closable` to `new-distributor`. |
| `start_airdrop_version` | Starting distributor version (per mint; `0` is safe). Omit/`null` to let the cli auto-detect the next version. |
| `csv_dir` | Directory holding the input CSVs. The `--csv-dir` flag overrides it; omit both to fall back to `./if-csv` (IF) / `./dfx-csv` (DFX). |
| `trees_dir` | Output directory for generated trees. The `--trees-dir` flag overrides it; omit both to fall back to `./if-trees` (IF) / `./dfx-trees` (DFX). |

`rpc_url`, `program_id`, `keypair_path`, `start_vesting_ts`, `end_vesting_ts`,
`clawback_start_ts`, `enable_slot`, and `max_nodes_per_tree` are required — a
missing one fails preflight with a clear message rather than mid-deploy.
`csv_dir`/`trees_dir` are optional (flag > config > built-in default).

IF config adds a `markets` array; each entry has `index`, `symbol`, `mint`. DFX
config instead has a single `mint`, `symbol`, and an optional `csv_path`.
Neither carries `decimals` or `csv_amount_unit` — see "Amount units".

## Amount units

Both flows generate trees in **base-unit mode**: `deploy_market` always passes
`--csv-amount-unit tokens --decimals 0`, so each CSV `amount`/`locked_amount`
integer is the exact on-chain claim amount with no scaling and no rounding
(scale = 10^0 = 1).

The CSV therefore holds **raw token base units**, not UI token amounts. Both IF
and DFX entitlements are sourced as base units (IF from on-chain Insurance Fund
balances), so this is lossless. There is no `decimals` or `csv_amount_unit`
knob to misconfigure — base-unit mode is fixed in the script.

Example: a claimant owed 1.23456 SOL (9 decimals) is a CSV row of `1234560000`.

## deploy-if.sh

```bash
./scripts/deploy-if.sh \
  --config scripts/if-markets.json \
  --csv-dir ./if-csv \
  --trees-dir ./if-trees
```

| Flag | Default | Notes |
|---|---|---|
| `--config` | `scripts/if-markets.json` | IF config JSON. |
| `--csv-dir` | `./if-csv` | Per-market CSV resolves to `<csv-dir>/<index>-<symbol>.csv`. |
| `--trees-dir` | `./if-trees` | Per-market trees write to `<trees-dir>/<index>-<symbol>/`. |
| `--start-index N` | — | Skip markets with `index < N` (resume an interrupted run). |
| `--dry-run` | off | Print the CLI commands instead of executing. |

It iterates `markets[]`, calls `deploy_market` per market, and prints a final
per-market success/fail summary (non-zero exit if any failed).

## deploy-dfx.sh

```bash
./scripts/deploy-dfx.sh \
  --config scripts/dfx-config.json \
  --csv-dir ./dfx-csv \
  --trees-dir ./dfx-trees
```

| Flag | Default | Notes |
|---|---|---|
| `--config` | `scripts/dfx-config.json` | DFX config JSON. |
| `--csv-dir` | `./dfx-csv` | Used only when `csv_path` is unset; resolves to `<csv-dir>/<symbol>.csv`. |
| `--trees-dir` | `./dfx-trees` | Trees write to `<trees-dir>/<symbol>/`. |
| `--dry-run` | off | Print the CLI commands instead of executing. |

The DFX CSV doesn't fit the `<index>-<symbol>` convention, so set `csv_path`
explicitly in the config (it falls back to `<csv-dir>/<symbol>.csv`).

## Dry-run

`--dry-run` prints the exact, copy-pasteable `create-merkle-tree` and
`new-distributor` commands for each market without touching the chain. Under
dry-run a missing CSV is only a warning (so you can preview before generating
CSVs); in a real run a missing CSV is a hard error.

```bash
./scripts/deploy-if.sh --config scripts/if-markets.example.json \
  --csv-dir /tmp/if-csv --trees-dir /tmp/if-trees --dry-run
```

## Caveats

- Each market has a distinct mint, so `start_airdrop_version: 0` is safe per
  market. The distributor PDA is derived from `["MerkleDistributor", mint,
  version]`, so versions only need to be unique per mint.
- `--amount 0` is the per-leaf fallback; trees carry per-leaf amounts from the
  CSV, matching documented DFX usage.
- Funding and verification are deliberately manual — confirm on-chain fields
  before funding, then fund and verify per `DEPLOY.md`.
