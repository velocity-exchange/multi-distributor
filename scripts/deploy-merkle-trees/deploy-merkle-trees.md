# Merkle-tree deploy scripts

Config-driven wrappers around the `cli` binary that generate merkle trees,
create on-chain distributors, and fund their vaults. The entry points share one
helper so the CLI-call sequence never drifts:

- [`deploy-if.sh`](./deploy-if.sh) — Insurance Fund (IF): many merkle trees
  across many mints, one per spot market index (~63 markets). When markets
  share a mint, run `cli aggregate-if-csvs` first to merge them into one
  distributor per mint (see "aggregate-if-csvs" below).
- [`deploy-dfx.sh`](./deploy-dfx.sh) — the single DFX IOU mint.
- [`fund-if.sh`](./fund-if.sh) / [`fund-dfx.sh`](./fund-dfx.sh) — fund the
  distributor vaults created by the matching deploy script.
- [`deploy-common.sh`](./deploy-common.sh) — sourced by all; holds preflight
  checks, the `cli` path resolver, jq config readers, and the shared
  `deploy_market()` and `fund_market()` functions.

## Scope

The deploy scripts do two steps per market:

1. `create-merkle-tree` — generate the sharded trees from the CSV.
2. `new-distributor` — create the on-chain distributor(s) for those trees.

The fund scripts do one step per market — `fund-all` against the trees dir —
topping each distributor vault up to its remaining (unclaimed) entitlement from
the funder's token account. The funder keypair must already hold each mint's
tokens (for IF, a funded ATA per market mint).

Funding is **idempotent, including after claiming has started**. For each vault
the cli computes a target of `max_total_claim − total_amount_claimed` (read from
the on-chain distributor) — the amount a fully-funded vault must hold to cover
all _remaining_ claims — and transfers only the deficit between that target and
the vault's current balance. So a vault that is already fully funded (with or
without prior claims) is skipped, a partially funded vault is topped up, and a
claimed-against vault is **not** over-funded. Clawed-back distributors are
skipped entirely (their vaults are drained and claiming is disabled, so funding
would only strand tokens). This makes re-running safe both after a partial
deploy/funding failure and after claiming has begun.

**Out of scope (run manually):** the `verify` step and generating the input
CSVs. See [`DEPLOY.md`](../DEPLOY.md).

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

| Key                     | Notes                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpc_url`               | Solana RPC URL.                                                                                                                                                                                     |
| `program_id`            | Distributor program id.                                                                                                                                                                             |
| `keypair_path`          | Admin/payer keypair. A leading `~` is expanded to `$HOME`.                                                                                                                                          |
| `priority`              | Priority fee (microlamports), or `null` to omit `--priority`.                                                                                                                                       |
| `start_vesting_ts`      | Vesting window start. `end_vesting_ts` is always derived as `start_vesting_ts + 1` (vesting is disabled — claims are fully unlocked at open); any `end_vesting_ts` in the config is ignored.        |
| `clawback_start_ts`     | Clawback period start.                                                                                                                                                                              |
| `enable_slot`           | Claim-open slot, or `0` for immediate.                                                                                                                                                              |
| `max_nodes_per_tree`    | Tree sharding size (e.g. `10000`).                                                                                                                                                                  |
| `closable`              | Boolean; `true` passes `--closable` to `new-distributor`.                                                                                                                                           |
| `start_airdrop_version` | Starting distributor version (per mint; `0` is safe). Omit/`null` to let the cli auto-detect the next version.                                                                                      |
| `csv_dir`               | Directory holding the input CSVs. The `--csv-dir` flag overrides it; omit both to fall back to `./if-csv` (IF) / `./dfx-csv` (DFX).                                                                 |
| `processed_csv_dir`     | (IF only) Where by-mint aggregation writes its merged CSVs + `merged-config.json`. The `--processed-csv-dir` flag overrides it; omit both to fall back to `./if-post-csv`. See "Same-mint markets". |
| `trees_dir`             | Output directory for generated trees. The `--trees-dir` flag overrides it; omit both to fall back to `./if-trees` (IF) / `./dfx-trees` (DFX).                                                       |

`rpc_url`, `program_id`, `keypair_path`, `start_vesting_ts`,
`clawback_start_ts`, `enable_slot`, and `max_nodes_per_tree` are required — a
missing one fails preflight with a clear message rather than mid-deploy.
`end_vesting_ts` is not required: it is always derived as `start_vesting_ts + 1`.
`csv_dir`/`processed_csv_dir`/`trees_dir` are optional (flag > config > built-in
default).

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

## Same-mint markets (automatic by-mint aggregation)

Spot markets are not guaranteed to have unique mints — e.g. several markets can
all be denominated in USDC. A claimant with entitlements in two same-mint
markets should claim their **combined** total once, from a single distributor,
not once per market (which would also collide on the per-mint distributor
version).

**`deploy-if.sh` and `fund-if.sh` handle this for you.** As their first step
they run the `aggregate-if-csvs` cli subcommand, which collapses the per-market
CSVs into **one deduped CSV per unique mint** — summing each claimant's `amount`
_and_ `locked_amount` across all markets sharing a mint — and writes a merged
config. The scripts then deploy/fund from that merged config, producing one
distributor per mint. The merge is a **no-op when every mint is already unique**.

`processed_csv_dir` (config key, or `--processed-csv-dir`) controls where the
artifacts land (default `./if-post-csv`):

- `<processed_csv_dir>/<index>-<symbol>.csv` — one deduped CSV per unique mint.
- `<processed_csv_dir>/merged-config.json` — the config with `markets[]`
  collapsed to one entry per mint (each carries a `source_markets` audit list),
  `csv_dir` repointed at `processed_csv_dir`.

These artifacts are **kept, not deleted** — `merged-config.json` is an auditable
record of exactly what was deployed, and `fund-if.sh` reuses it so the funded
vaults line up one-to-one with the deployed distributors (it regenerates only if
the file is missing).

Notes:

- Output is sorted by pubkey, so merged CSVs and merkle roots are reproducible
  and diffs stay clean. There is exactly one row per claimant.
- Merging is sound because vesting/clawback/enable settings are shared across
  all markets (top-level config keys), so same-mint markets carry identical
  distributor terms. The combined `index`/`symbol` come from the lowest-index
  source market; a same-mint symbol mismatch logs a warning.
- The summation is done explicitly rather than relying on `create-merkle-tree`'s
  duplicate-claimant combine, which sums `amount` only and drops later
  `locked_amount`s.
- Aggregation is a local file transform (no chain writes), so it also runs under
  `--dry-run` to keep the printed commands accurate.

You can also run the step manually if you want to inspect the merged output
before deploying:

```bash
cli aggregate-if-csvs \
  --config scripts/if-markets.json --csv-dir ./if-csv/devnet \
  --out-csv-dir ./if-post-csv/devnet --out-config ./if-post-csv/devnet/merged-config.json
```

## deploy-if.sh

```bash
./scripts/deploy-if.sh \
  --config scripts/if-markets.json \
  --csv-dir ./if-csv \
  --trees-dir ./if-trees
```

| Flag                  | Default                   | Notes                                                                                         |
| --------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `--config`            | `scripts/if-markets.json` | IF config JSON.                                                                               |
| `--csv-dir`           | `./if-csv`                | Per-market CSV resolves to `<csv-dir>/<index>-<symbol>.csv`.                                  |
| `--processed-csv-dir` | `./if-post-csv`           | Where by-mint aggregation writes merged CSVs + `merged-config.json`. See "Same-mint markets". |
| `--trees-dir`         | `./if-trees`              | Per-mint trees write to `<trees-dir>/<index>-<symbol>/`.                                      |
| `--start-index N`     | —                         | Skip markets with `index < N` (resume an interrupted run).                                    |
| `--dry-run`           | off                       | Print the CLI commands instead of executing.                                                  |

It first aggregates same-mint markets (see "Same-mint markets"), then iterates
the merged `markets[]` (one entry per unique mint), calls `deploy_market` per
mint, and prints a final per-mint success/fail summary (non-zero exit if any
failed).

## deploy-dfx.sh

```bash
./scripts/deploy-dfx.sh \
  --config scripts/dfx-config.json \
  --csv-dir ./dfx-csv \
  --trees-dir ./dfx-trees
```

| Flag          | Default                   | Notes                                                                     |
| ------------- | ------------------------- | ------------------------------------------------------------------------- |
| `--config`    | `scripts/dfx-config.json` | DFX config JSON.                                                          |
| `--csv-dir`   | `./dfx-csv`               | Used only when `csv_path` is unset; resolves to `<csv-dir>/<symbol>.csv`. |
| `--trees-dir` | `./dfx-trees`             | Trees write to `<trees-dir>/<symbol>/`.                                   |
| `--dry-run`   | off                       | Print the CLI commands instead of executing.                              |

The DFX CSV doesn't fit the `<index>-<symbol>` convention, so set `csv_path`
explicitly in the config (it falls back to `<csv-dir>/<symbol>.csv`).

## fund-if.sh / fund-dfx.sh

Run these after the matching deploy script, once the funder keypair holds the
relevant tokens. They reuse the same config files and need the trees dir; `fund-if.sh`
also reuses the `merged-config.json` deploy wrote under `processed_csv_dir` so it
funds the same by-mint distributors (regenerating it from the source CSVs only if
missing — `--csv-dir`/`--processed-csv-dir` cover that case).

```bash
./scripts/deploy-merkle-trees/fund-if.sh  --config scripts/if-markets.json  --trees-dir ./if-trees
./scripts/deploy-merkle-trees/fund-dfx.sh --config scripts/dfx-config.json --trees-dir ./dfx-trees
```

| Flag                  | Notes                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config`            | Same config as the matching deploy script.                                                                                                                                       |
| `--csv-dir`           | (IF only) Source CSVs, used only to regenerate the merged config if missing (flag > config `csv_dir` > `./if-csv`).                                                              |
| `--processed-csv-dir` | (IF only) Where deploy wrote `merged-config.json` (flag > config `processed_csv_dir` > `./if-post-csv`).                                                                         |
| `--trees-dir`         | Where the deploy script wrote the trees (flag > config `trees_dir` > `./if-trees` / `./dfx-trees`). IF reads `<trees-dir>/<index>-<symbol>/`; DFX reads `<trees-dir>/<symbol>/`. |
| `--start-index N`     | (IF only) Skip markets with `index < N` to resume an interrupted run.                                                                                                            |
| `--dry-run`           | Print the `fund-all` commands instead of executing.                                                                                                                              |

`fund-if.sh` iterates `markets[]` and prints a per-market success/fail summary
(non-zero exit if any failed), mirroring `deploy-if.sh`. Because funding is
idempotent (it tops up to the remaining unclaimed entitlement — see "Scope"),
re-running after a partial failure only funds the still-unfunded vaults, and
re-running after claiming has begun does not over-fund.

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

- The distributor PDA is derived from `["MerkleDistributor", mint, version]`,
  so distributor versions only need to be unique per mint. If two markets share
  a mint, deploying both as separate distributors would either collide on
  version `0` or need distinct versions — run `aggregate-if-csvs` first
  (above) so each unique mint maps to exactly one distributor and
  `start_airdrop_version: 0` stays safe.
- `--amount 0` is the per-leaf fallback; trees carry per-leaf amounts from the
  CSV, matching documented DFX usage.
- Funding and verification are deliberately manual — confirm on-chain fields
  before funding, then fund and verify per `DEPLOY.md`.
