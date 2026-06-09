# Merkle-tree deploy toolkit

Turn [`drift-labs/dfx-calculation`](https://github.com/drift-labs/dfx-calculation)
entitlement snapshots into funded, on-chain merkle distributors. Two flows share
the same machinery:

- **IF** (Insurance Fund) — many distributors, one per spot market (~63 markets,
  each its own mint; same-mint markets are merged automatically).
- **DFX** — the single DFX IOU mint.

Everything here drives the repo's `cli` binary from JSON config so the CLI-call
sequence never drifts between markets.

## The pipeline

Four phases, in order: **import → prepare → deploy → fund**. Run every command
**from this directory** (`scripts/deploy-merkle-trees/`) — the example configs
use `./data/...` paths that only resolve here.

```
①  import      dfx-calculation snapshots  ->  csv-prep/
②  prepare     csv-prep/*.py              ->  data/<flow>-csv/<net>/...   (deploy-ready CSVs)
③  deploy      deploy-{if,dfx}.sh         ->  trees + on-chain distributors
④  fund        fund-{if,dfx}.sh           ->  distributor vaults topped up
```

### Prerequisites

- `jq` on `PATH`.
- The `cli` binary built: `cargo build` (or `--release`) from the repo root.
- A deployer/funder keypair (set in the config); for funding it must already
  hold each mint's tokens.

### ① Import snapshots

The entitlement snapshots are produced upstream by `dfx-calculation`. Copy its
outputs into `csv-prep/` (the copies committed here are the current snapshot —
overwrite them to refresh):

```bash
git clone https://github.com/drift-labs/dfx-calculation
cp dfx-calculation/insurance-fund/snapshots/*.csv csv-prep/if-snapshots/   # IF
cp dfx-calculation/dfx/dfx-snapshot.csv          csv-prep/dfx-snapshot.csv  # DFX
```

### ② Prepare deploy-ready CSVs

Convert the snapshots into the `pubkey,amount,locked_amount` shape
`create-merkle-tree` consumes (raw base units). See
[`csv-prep/README.md`](./csv-prep/README.md) for details and filtering rules.

```bash
# IF: one CSV per market -> data/if-csv/devnet/raw/  (deploy reads <csv-dir>/raw/)
./csv-prep/prepare-if-csv.py \
  --src csv-prep/if-snapshots \
  --out-dir data/if-csv/devnet/raw \
  --market-config if-markets.json      # optional: per-market min-amount thresholds

# DFX: a single CSV -> data/dfx-csv/devnet/DFX.csv
./csv-prep/prepare-dfx-csv.py \
  --src csv-prep/dfx-snapshot.csv \
  --out-dir data/dfx-csv/devnet
```

### ③ Deploy (generate trees + create distributors)

Copy an example config and fill it in — the real files are gitignored:

```bash
cp if-markets.example.json  if-markets.json
cp dfx-config.example.json  dfx-config.json
```

The example configs already point `csv_dir`/`trees_dir` at `./data/...`, so no
`--csv-dir`/`--trees-dir` is needed when run from here:

```bash
./deploy-if.sh  --config if-markets.json
./deploy-dfx.sh --config dfx-config.json
```

Add `--dry-run` to print the exact, copy-pasteable CLI commands without touching
the chain.

### ④ Fund the vaults

After deploy, once the funder keypair holds the tokens. Funding is idempotent
(tops each vault up to its remaining unclaimed entitlement), so it's safe to
re-run after a partial failure or after claiming has begun:

```bash
./fund-if.sh  --config if-markets.json
./fund-dfx.sh --config dfx-config.json
```

The **`verify`** step is deliberately manual — confirm on-chain distributor
fields before/after funding. See [`../../DEPLOY.md`](../../DEPLOY.md).

## What's in here

```
deploy-merkle-trees/
├── README.md                 you are here — the import→prepare→deploy→fund guide
├── deploy-merkle-trees.md    full reference: every flag, config key, and caveat
│
├── csv-prep/                 phase ②, plus the imported snapshots from phase ①
│   ├── README.md             prep details + filtering rules
│   ├── prepare-if-csv.py     IF snapshots  -> per-market CSVs
│   ├── prepare-dfx-csv.py    DFX snapshot  -> single CSV
│   ├── if-snapshots/         imported IF snapshots (one <index>_<symbol>.csv per market)
│   └── dfx-snapshot.csv      imported DFX notional snapshot
│
├── deploy-if.sh   deploy-dfx.sh    phase ③ — trees + new-distributor
├── fund-if.sh     fund-dfx.sh      phase ④ — fund-all
├── deploy-common.sh                shared helpers sourced by all four scripts
│
├── if-markets.example.json   copy -> if-markets.json (gitignored), fill in
├── if-markets.mainnet.json   mainnet IF market list (index/symbol/mint)
├── dfx-config.example.json   copy -> dfx-config.json (gitignored), fill in
│
└── data/                     generated outputs (CSVs + trees), by flow and network
    ├── if-csv/<net>/raw/         phase ② output: prepared per-market CSVs
    ├── if-csv/<net>/processed/   by-mint merged CSVs + merged-config.json (auto)
    ├── if-trees/<net>/           phase ③ output: generated IF trees
    ├── dfx-csv/<net>/            phase ② output: prepared DFX CSV
    └── dfx-trees/<net>/          phase ③ output: generated DFX trees
```

## Reference docs

- [`deploy-merkle-trees.md`](./deploy-merkle-trees.md) — full flag reference, all
  config keys, amount units, same-mint aggregation, and caveats.
- [`csv-prep/README.md`](./csv-prep/README.md) — snapshot → CSV conversion details.
- [`../../MERKLE_TREES.md`](../../MERKLE_TREES.md) — the CSV format and tree-versioning rules.
- [`../../DEPLOY.md`](../../DEPLOY.md) — end-to-end runbook including the manual `verify` step.
