# Drift DFX IOU Claims

A standalone claim program and supporting toolset for distributing DFX IOU tokens through Merkle proofs.

This repo is forked from Merkle distributor tooling and keeps the existing distributor/claim model intact: each claim tree stores a Merkle root, each claimant proves their allocation, and tokens are paid from a program-owned vault.

## Program ID

Current planned DFX distributor program ID:

```text
Fxwtf2gpP31Dv5RweUXmSPaLtgCZsp18GVLhYZPnUJP1
```

The matching program keypair is intentionally not committed. Keep it outside git and copy it to `target/deploy/merkle_distributor-keypair.json` only when preparing a deploy. If the deployer chooses a different keypair later, run `anchor keys sync` and update downstream `dfx-claim` configuration.

## Token Mint

The DFX IOU mint itself is created with the helpers under [`scripts/`](scripts/README.md):

1. [`scripts/upload-metadata`](scripts/upload-metadata) — TypeScript uploader (Metaplex Umi + Irys) that pushes the logo image and off-chain JSON to Arweave and returns the metadata URI.
2. [`scripts/create-vanity-token.sh`](scripts/create-vanity-token.sh) — grinds a vanity mint address, creates the classic SPL Token, attaches Metaplex Token Metadata via `metaboss` (immutable), mints the initial supply, verifies the wallet balance, and disables the mint authority.

See [`scripts/README.md`](scripts/README.md) for prerequisites, the full flag reference, the end-to-end chained example, and mainnet caveats (immutable metadata, freeze authority handling, vanity prefix cost).

The resulting mint address is what gets passed as `--mint [TOKEN_MINT]` to every CLI command below.

## Claim Model

- Create one distributor per asset or market-specific asset bucket.
- Build leaves at the Drift authority level.
- For immediate DFX IOU claims, set each leaf with `amount_unlocked = full entitlement` and `amount_locked = 0`.
- Fund each distributor vault with the intended token amount by SPL transfer.
- Users call `new_claim` once per eligible distributor to withdraw their unlocked amount.

The vesting fields remain available for compatibility with the original program. For DFX IOU claims, use unlocked-only trees and a far-future clawback timestamp.

## CLI

Build sharded Merkle trees, create distributors, fund vaults, and verify setup:

```sh
cargo build

target/debug/cli create-merkle-tree --csv-path [CSV_PATH] --merkle-tree-path [MERKLE_TREE_DIR] --max-nodes-per-tree 12000

target/debug/cli --mint [TOKEN_MINT] --keypair-path [KEYPAIR] --rpc-url [RPC] new-distributor --start-vesting-ts [START_TS] --end-vesting-ts [END_TS] --merkle-tree-path [MERKLE_TREE_DIR] --clawback-start-ts [CLAWBACK_START_TS] --enable-slot [ENABLE_SLOT]

target/debug/cli --mint [TOKEN_MINT] --keypair-path [KEYPAIR] --rpc-url [RPC] fund-all --merkle-tree-path [MERKLE_TREE_DIR]

target/debug/cli --mint [TOKEN_MINT] --keypair-path [KEYPAIR] --rpc-url [RPC] verify --merkle-tree-path [MERKLE_TREE_DIR] --clawback-start-ts [CLAWBACK_START_TS] --enable-slot [ENABLE_SLOT] --admin [ADMIN]
```

See [MERKLE_TREES.md](MERKLE_TREES.md) for CSV format, amount units, and distributor-version guidance.

## Development With Devcontainer

This repo includes a devcontainer with pinned Rust, Solana, and Anchor versions for program development.

Build the container:

```sh
cd .devcontainer
docker build -t dfx-distributor-dev .
```

Start the devcontainer service:

```sh
docker compose up -d
```

Open a shell inside it:

```sh
docker compose exec dfx-distributor /bin/bash
```

Alternatively, use your IDE's devcontainer integration. In VS Code or Cursor:

1. Press `Cmd+Shift+P` on macOS, or `Ctrl+Shift+P` elsewhere.
2. Run `Dev Containers: Reopen in Container`.
3. Wait for the container to build.
4. Use the IDE terminal inside the devcontainer.

Common commands:

```sh
# build program without requiring the deploy keypair
anchor build

# build program with keypair check
mkdir -p target/deploy
cp /path/to/merkle_distributor-keypair.json target/deploy/merkle_distributor-keypair.json
anchor build

# update checked-in IDL after build
cp target/idl/merkle_distributor.json programs/merkle-distributor/idl/merkle_distributor.json

# run Rust tests
cargo test -p merkle-distributor --lib
cargo test -p jito-merkle-tree
```

## API

The Axum server under `api` serves Merkle proof and claim-status data for users.

```sh
cargo build
target/debug/drift-dfx-distributor-api --merkle-tree-path [MERKLE_TREE_DIR] \
  --program-id Fxwtf2gpP31Dv5RweUXmSPaLtgCZsp18GVLhYZPnUJP1 \
  --mint [TOKEN_MINT] \
  --rpc-url https://your.rpc.com \
  --ws-url wss://your.rpc.com
```
