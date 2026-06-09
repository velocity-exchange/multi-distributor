# CSV prep — snapshot → deploy-ready merkle CSVs

Phase ② of the pipeline (see [`../README.md`](../README.md)). The deploy scripts
(`deploy-if.sh`, `deploy-dfx.sh`) deliberately leave CSV generation manual (see
[`../deploy-merkle-trees.md`](../deploy-merkle-trees.md), "Out of scope"). These
two scripts fill that gap: they convert the upstream `dfx-calculation` snapshots
(imported into this dir, phase ①) into the exact CSV shape `create-merkle-tree`
consumes.

Both scripts **require** `--src` and `--out-dir` — there are no baked-in
defaults. Run them from `scripts/deploy-merkle-trees/` so the paths below match.

## Target format

Both scripts emit the shape documented in [`../../../MERKLE_TREES.md`](../../../MERKLE_TREES.md)
and matched by the bundled devnet samples (`../data/{if,dfx}-csv/devnet/`):

```
pubkey,amount,locked_amount
<base58>,<integer base units>,0
```

`deploy_market()` always generates trees in **base-unit mode**
(`--csv-amount-unit tokens --decimals 0`), so `amount` is the exact on-chain
claim with no scaling. `locked_amount` is always `0` (no vesting lock per leaf).
Rows with a non-positive amount are dropped — nothing to claim.

## prepare-if-csv.py

Source: `if-snapshots/<index>_<symbol>.csv` (imported from
`dfx-calculation/insurance-fund/snapshots/`; columns include `authority` and
`tokenAmount`, the latter already raw base units). Output: one
`<index>-<symbol>.csv` per market (underscore → dash, the convention
`deploy-if.sh` expects).

`amount = sum(tokenAmount)` per authority (summed if an authority appears in
multiple rows of one market). No unit scaling — `tokenAmount` is copied through.
`--market-config` enables per-market min-amount thresholds from the `decimals`
field in `if-markets.json`; without it every market uses the fallback threshold.

```bash
# deploy-if.sh reads source CSVs from <csv-dir>/raw/, so write there:
./csv-prep/prepare-if-csv.py --src csv-prep/if-snapshots --out-dir data/if-csv/devnet/raw
./csv-prep/prepare-if-csv.py --src csv-prep/if-snapshots --out-dir data/if-csv/devnet/raw \
    --market-config if-markets.json       # per-market min-amount thresholds
./csv-prep/prepare-if-csv.py --src csv-prep/if-snapshots --out-dir data/if-csv/devnet/raw \
    --only 0,1,15                         # specific market indexes only
```

## prepare-dfx-csv.py

Source: `dfx-snapshot.csv` (imported from `dfx-calculation/dfx/dfx-snapshot.csv`;
columns `authority`, `total_notional` — USD with 6 decimals). Output: a single
`<symbol>.csv` (default `DFX.csv`).

The DFX IOU mint is a 6-decimal token pegged 1:1 to USD notional, so
`amount = round(total_notional * 10**decimals)` with `decimals=6` — exact,
since the snapshot prints exactly 6 fractional digits. Decimal arithmetic
throughout (no float rounding). Override `--decimals` only if the mint's
decimals differ.

```bash
./csv-prep/prepare-dfx-csv.py --src csv-prep/dfx-snapshot.csv --out-dir data/dfx-csv/devnet
./csv-prep/prepare-dfx-csv.py --src csv-prep/dfx-snapshot.csv --out-dir data/dfx-csv/devnet \
    --symbol DFX --decimals 6
```

## Wiring into a deploy

Write the prepared CSVs to where the deploy scripts (and the example configs)
expect them, then deploy. The example configs already set `csv_dir`/`trees_dir`
to `./data/...`, so no `--csv-dir` is needed when run from
`scripts/deploy-merkle-trees/`:

```bash
# IF: deploy reads <csv-dir>/raw/, and the example config's csv_dir is
#     ./data/if-csv/devnet — so prepare wrote to data/if-csv/devnet/raw/.
./deploy-if.sh --config if-markets.json --dry-run

# DFX: the example config's csv_dir is ./data/dfx-csv/devnet and symbol is DFX,
#      so deploy reads data/dfx-csv/devnet/DFX.csv. (Or set csv_path explicitly.)
./deploy-dfx.sh --config dfx-config.json --dry-run
```

See [`../README.md`](../README.md) for the full import→prepare→deploy→fund flow.

### Caveat: empty markets

Some IF markets have no positive balances (e.g. `41-PT-fragSOL-10JUL25`, the
`Default_Market_Name` markets). The script always writes a CSV for every market,
but empty ones contain only the header row — the script prints `-> 0 claimants [empty]`
for each so they're easy to spot. A market with zero claimants cannot form a tree —
**omit those indexes from `if-markets.json`'s `markets[]`** (or they'll fail at
`create-merkle-tree`, though `deploy-if.sh` will continue to the next market).
