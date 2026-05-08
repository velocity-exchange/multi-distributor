# DFX IOU Claim Merkle Tree Generation

This guide describes how to generate Merkle trees for Drift DFX IOU claims.

## Input CSV

The CLI expects a CSV with these headers:

```csv
pubkey,amount,locked_amount
AuthorityPubkey111111111111111111111111111111,123,0
AuthorityPubkey222222222222222222222222222222,456,0
```

For DFX IOU claims:

```text
pubkey = Drift authority-level claimant
amount = full immediately withdrawable entitlement
locked_amount = 0
```

## Amount Units

The current parser treats `amount` and `locked_amount` as integer UI units, then multiplies by `10^decimals`.

Example for USDC:

```text
CSV amount = 123
--decimals 6
on-chain claim amount = 123_000_000
```

Example for SOL:

```text
CSV amount = 2
--decimals 9
on-chain claim amount = 2_000_000_000
```

If production entitlements require fractional UI amounts, either provide base units with `--decimals 0`, or update the parser to support decimal strings safely.

### Fractional UI amounts via cents (recommended)

Keep **`--decimals`** equal to the **SPL mint decimals** (e.g. `6` for DFX-style tokens). If integer CSV amounts are **cents** of the UI token (two decimal places), pass **`--csv-amount-unit cents`**:

```text
CSV amount = 8255   (82.55 tokens expressed as cents)
--decimals 6
--csv-amount-unit cents
on-chain claim amount = 8255 × 10^(6−2) = 82_550_000 base units = 82.55 tokens
```

Requires mint decimals **≥ 2**. **`locked_amount`** uses the same unit.

Default **`--csv-amount-unit tokens`** means integers are **whole UI tokens** (× `10^decimals`), unchanged from older behavior.

`merkle-tree/convert_dfx_users_to_merkle.py` emits **cents**; use **`--decimals 6 --csv-amount-unit cents`** for a 6-decimal mint.

## Build CLI

```sh
cargo build
```

## Generate Trees

Create one output directory per asset or market-specific asset bucket.

```sh
mkdir -p dfx-claim-trees/usdc

target/debug/cli create-merkle-tree \
  --csv-path path/to/usdc_authority_claims.csv \
  --merkle-tree-path dfx-claim-trees/usdc \
  --max-nodes-per-tree 10000 \
  --amount 0 \
  --decimals 6 \
  --start-airdrop-version 0
```

The command writes files like:

```text
dfx-claim-trees/usdc/tree_0.json
dfx-claim-trees/usdc/tree_1.json
```

The generated JSON includes the Merkle root, max claim amount, max node count, per-user proofs, and `airdrop_version`. The code still uses the historical name `airdrop_version`; operationally this is the distributor version.

## Versioning

Distributor PDAs are derived from:

```text
["MerkleDistributor", mint, version]
```

For two trees using the same mint, versions must not collide. Use distinct version ranges for duplicate or market-specific assets.

Example:

```sh
# USDC market index 0
target/debug/cli create-merkle-tree \
  --csv-path path/to/usdc_authority_claims.csv \
  --merkle-tree-path dfx-claim-trees/usdc \
  --max-nodes-per-tree 10000 \
  --amount 0 \
  --decimals 6 \
  --start-airdrop-version 0

# USDC-1 market index 34, same mint but distinct distributor versions
target/debug/cli create-merkle-tree \
  --csv-path path/to/usdc_1_authority_claims.csv \
  --merkle-tree-path dfx-claim-trees/usdc-1 \
  --max-nodes-per-tree 10000 \
  --amount 0 \
  --decimals 6 \
  --start-airdrop-version 100
```

If the mint has already been used on-chain and no explicit start version is supplied, the CLI can search for the next available PDA version when `--mint`, `--program-id`, and `--rpc-url` are provided.

## Sanity Checks

Before creating distributors:

- confirm the CSV is authority-level, not subaccount-level
- confirm every `locked_amount` is `0`
- confirm token decimals match the mint
- confirm output tree versions do not collide for the same mint
- confirm each tree's `max_total_claim` matches the amount expected to fund
- do not commit production CSVs or generated production tree JSON unless intentionally public
