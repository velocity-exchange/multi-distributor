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

Use **base-unit mode**: pass `--decimals 0` (with the default `--csv-amount-unit
tokens`) so the CSV `amount`/`locked_amount` integers are the **exact on-chain
claim amounts**, with no scaling and no rounding.

```text
CSV amount = 1234560000   (1.23456 SOL on a 9-decimal mint, as raw base units)
--decimals 0
on-chain claim amount = 1_234_560_000 base units = 1.23456 SOL
```

The CSV therefore holds **raw token base units**, not UI token amounts. Compute
each entitlement in base units upstream (on-chain balances are already in base
units) and write that integer straight into the CSV. `locked_amount` uses the
same unit.

The `cli` parser can also scale UI units (`--decimals <mint_decimals>`,
optionally `--csv-amount-unit cents`), but the deploy scripts and this guide use
base units so fractional amounts are never lost to rounding.

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
  --decimals 0 \
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
  --decimals 0 \
  --start-airdrop-version 0

# USDC-1 market index 34, same mint but distinct distributor versions
target/debug/cli create-merkle-tree \
  --csv-path path/to/usdc_1_authority_claims.csv \
  --merkle-tree-path dfx-claim-trees/usdc-1 \
  --max-nodes-per-tree 10000 \
  --amount 0 \
  --decimals 0 \
  --start-airdrop-version 100
```

If the mint has already been used on-chain and no explicit start version is supplied, the CLI can search for the next available PDA version when `--mint`, `--program-id`, and `--rpc-url` are provided.

## Sanity Checks

Before creating distributors:

- confirm the CSV is authority-level, not subaccount-level
- confirm every `locked_amount` is `0`
- confirm CSV amounts are raw base units (not UI token amounts)
- confirm output tree versions do not collide for the same mint
- confirm each tree's `max_total_claim` matches the amount expected to fund
- do not commit production CSVs or generated production tree JSON unless intentionally public
