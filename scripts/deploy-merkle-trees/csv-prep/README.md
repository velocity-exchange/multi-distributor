# CSV prep — snapshot → deploy-ready merkle CSVs

The deploy scripts (`deploy-if.sh`, `deploy-dfx.sh`) deliberately leave CSV
generation manual (see [`../deploy-merkle-trees.md`](../deploy-merkle-trees.md),
"Out of scope"). These two scripts fill that gap: they convert the upstream
`dfx-calculation` snapshots into the exact CSV shape `create-merkle-tree`
consumes.

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

Source: `dfx-calculation/insurance-fund/snapshots/<index>_<symbol>.csv`
(columns include `authority` and `tokenAmount`, the latter already raw base
units). Output: one `<index>-<symbol>.csv` per market (underscore → dash, the
convention `deploy-if.sh` expects).

`amount = sum(tokenAmount)` per authority (summed if an authority appears in
multiple rows of one market). No unit scaling — `tokenAmount` is copied through.

```bash
./prepare-if-csv.py                       # all defaults (paths baked in)
./prepare-if-csv.py --src <dir> --out-dir <dir>
./prepare-if-csv.py --only 0,1,15         # specific market indexes
```

## prepare-dfx-csv.py

Source: `dfx-calculation/dfx/dfx-snapshot.csv` (`authority`, `total_notional` —
USD with 6 decimals). Output: a single `<symbol>.csv` (default `DFX.csv`).

The DFX IOU mint is a 6-decimal token pegged 1:1 to USD notional, so
`amount = round(total_notional * 10**decimals)` with `decimals=6` — exact,
since the snapshot prints exactly 6 fractional digits. Decimal arithmetic
throughout (no float rounding). Override `--decimals` only if the mint's
decimals differ.

```bash
./prepare-dfx-csv.py                       # all defaults
./prepare-dfx-csv.py --src <file> --out-dir <dir> --symbol DFX --decimals 6
```

## Wiring into a deploy

`prepare-dfx-csv.py` writes to `../dfx-csv/DFX.csv` and `prepare-if-csv.py` to
`../if-csv/<index>-<symbol>.csv` by default. Point the deploy at them:

```bash
# DFX: set "csv_path": ".../csv-prep/.. /dfx-csv/DFX.csv" in dfx-config.json,
#      or pass --csv-dir.
./scripts/deploy-dfx.sh --config scripts/dfx-config.json --dry-run

# IF: point --csv-dir at the generated dir.
./scripts/deploy-if.sh --config scripts/if-markets.json \
  --csv-dir scripts/deploy-merkle-trees/if-csv --dry-run
```

### Caveat: empty markets

Some IF markets have no positive balances and produce a header-only CSV (e.g.
`41-PT-fragSOL-10JUL25`, the `Default_Market_Name` markets). A market with zero
claimants cannot form a tree — **omit those indexes from `if-markets.json`'s
`markets[]`** (or they'll fail at `create-merkle-tree`). The script prints
`-> 0 claimants` for each so they're easy to spot.
