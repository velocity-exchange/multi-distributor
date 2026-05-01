# Drift DFX IOU Claims Deploy Guide

This guide adapts the historical Merkle distributor deployment flow for the Drift DFX IOU claims program.

## Program IDs

Current DFX distributor program ID:

```text
Fxwtf2gpP31Dv5RweUXmSPaLtgCZsp18GVLhYZPnUJP1
```

The corresponding program keypair is intentionally not stored in this repo. Keep program keypairs outside git, and copy the keypair into `target/deploy/merkle_distributor-keypair.json` only when preparing a deploy.

## DFX IOU Claim Shape

For DFX IOU claims, use unlocked-only trees:

```text
amount_unlocked = full user entitlement
amount_locked = 0
```

Recommended distributor settings:

```text
start_vesting_ts = deploy/open timestamp
end_vesting_ts = start_vesting_ts + 1
clawback_start_ts = far future
enable_slot = desired claim-open slot, or 0 for immediate
closable = false
```

The contract requires `start_vesting_ts < end_vesting_ts`, so do not set them equal.

## 1. Build

```sh
cargo build
```

## 2. Optional Devnet Token

For devnet rehearsals, create and mint a test token:

```sh
spl-token create-token --decimals 6 -ud
spl-token create-account [MINT] -ud
spl-token mint [MINT] [AMOUNT] [TOKEN_ACCOUNT] -ud
```

## 3. Generate Merkle Trees

Generate sharded trees from the authority-level CSV.

```sh
target/debug/cli create-merkle-tree \
  --csv-path [CSV_PATH] \
  --merkle-tree-path [MERKLE_TREE_DIR] \
  --max-nodes-per-tree 10000 \
  --amount [DEFAULT_AMOUNT_DFX_USED] \
  --decimals [TOKEN_DECIMALS]
```

The generated `tree_*.json` files contain the Merkle root, max claim amount, max node count, proofs, and `airdrop_version`. The code still uses the historical name `airdrop_version`; operationally this is the distributor version.

If creating multiple distributors for the same mint, versions must not collide because the distributor PDA is derived from:

```text
["MerkleDistributor", mint, version]
```

## 4. Create Distributors

Create distributors for each asset or market-specific asset bucket.

```sh
target/debug/cli \
  --mint [TOKEN_MINT] \
  --priority [MICROLAMPORTS_OPTIONAL] \
  --program-id Fxwtf2gpP31Dv5RweUXmSPaLtgCZsp18GVLhYZPnUJP1 \
  --rpc-url [RPC_URL] \
  --keypair-path [ADMIN_KEYPAIR] \
  new-distributor \
  --enable-slot [ENABLE_SLOT] \
  --merkle-tree-path [MERKLE_TREE_DIR] \
  --start-vesting-ts [START_TS] \
  --end-vesting-ts [END_TS] \
  --clawback-start-ts [CLAWBACK_START_TS]
```

After each transaction succeeds, verify the on-chain distributor fields match the intended root, admin, clawback receiver, timestamps, enable slot, and max claim amount.

## 5. Fund Distributors

Funding is a normal SPL token transfer into each distributor vault. The CLI can fund every tree in a directory:

```sh
target/debug/cli \
  --mint [TOKEN_MINT] \
  --program-id Fxwtf2gpP31Dv5RweUXmSPaLtgCZsp18GVLhYZPnUJP1 \
  --rpc-url [RPC_URL] \
  --keypair-path [FUNDER_KEYPAIR] \
  fund-all \
  --merkle-tree-path [MERKLE_TREE_DIR]
```

Anyone can transfer tokens into a vault, but claims remain bounded by the Merkle root and `max_total_claim`. Extra tokens should be treated as surplus/dust and handled by the clawback policy.

## 6. Verify Setup

```sh
target/debug/cli \
  --mint [TOKEN_MINT] \
  --program-id Fxwtf2gpP31Dv5RweUXmSPaLtgCZsp18GVLhYZPnUJP1 \
  --rpc-url [RPC_URL] \
  --keypair-path [KEYPAIR] \
  verify \
  --merkle-tree-path [MERKLE_TREE_DIR] \
  --clawback-start-ts [CLAWBACK_START_TS] \
  --enable-slot [ENABLE_SLOT] \
  --admin [ADMIN]
```

Verification should confirm:

- distributor PDA exists for every generated tree
- on-chain root equals the generated root
- vault balance is at least `max_total_claim`
- admin is the DFX admin multisig
- clawback receiver is the intended token account
- timestamps and enable slot match the deploy plan

## 7. API Server

The API serves distributor and user proof data.

```sh
target/debug/drift-dfx-distributor-api \
  --merkle-tree-path [MERKLE_TREE_DIR] \
  --program-id Fxwtf2gpP31Dv5RweUXmSPaLtgCZsp18GVLhYZPnUJP1 \
  --mint [TOKEN_MINT] \
  --rpc-url [RPC_URL] \
  --ws-url [WS_URL]
```

Historical deploy note: if the API pod fails to mount its EFS volume, check for stale AWS file-system policies before debugging the app itself.

## Operational Notes

- Keep `closable = false` for production DFX IOU distributors.
- Use one API/tree directory layout that cannot clobber proofs for the same claimant across multiple trees.
- Use separate distributor versions for duplicate market labels that share the same mint.
- Do not commit generated keypairs, production CSVs, Merkle trees, or private deploy scripts unless they are intentionally public.
- Re-run a devnet rehearsal before mainnet deployment using the exact same commands and tree-generation pipeline.
