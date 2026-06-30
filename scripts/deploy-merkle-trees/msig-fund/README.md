# IF multisig funding

Two tools here, both targeting the **Squads V4 multisig vault** that holds the
IF tokens:

- **`fund-if-msig.ts`** — fund merkle-distributor vaults (classic SPL Token
  markets). See below.
- **`distribute-t22-msig.ts`** — directly pay the **Token-2022** markets'
  holders (no distributor). See "Token-2022 direct distribution" at the bottom.

`fund-if-msig.ts` funds Insurance Fund (IF) distributor vaults when the tokens
live in a **Squads V4 multisig vault** instead of a hot keypair. It is the
multisig counterpart to `../fund-if.sh` / the Rust cli `fund-all`.

It does **not** move tokens itself — it builds the SPL transfers and submits a
Squads `vaultTransactionCreate` + `proposalCreate`. Multisig members still have
to approve and execute the proposal (via the Squads UI or CLI) before any tokens
move. The proposer keypair only pays rent and is recorded as the creator.

## What it does

For the selected market(s), for each merkle tree under
`<trees_dir>/<index>-<symbol>/`:

1. derives the distributor PDA `["MerkleDistributor", mint, version]` and its
   vault ATA;
2. computes the deficit exactly like `process_fund_all.rs`:
   `max_total_claim` (tree file) − `total_amount_claimed` (on-chain) − current
   vault balance — skips if already funded or clawed back;
3. emits `transfer(vaultAta → distributorVaultAta, authority = vault PDA)`.

One proposal is created per market. `--all` creates one proposal per
still-unfunded market with sequential transaction indexes.

## Prerequisites

- The distributors/trees already exist on-chain — run `../deploy-if.sh` first
  (this tool reads `<csv_dir>/processed/merged-config.json` that deploy wrote).
- The multisig vault already holds each market's mint (check with the
  comparison you ran against `4JM5…`).

## Mainnet IF multisig

| | |
|---|---|
| multisig PDA | `7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM` (3-of-5) |
| **vault holding the tokens** | **index 1** → `4JM5vsoGPkMMZCZusMC6rTNZpm4pFweBPQf36vT8yZ8x` |

> ⚠️ The funds are in **vault index 1**, not the default `0`. You must pass
> `--vault-index 1`. The tool prints the derived vault PDA at startup — confirm
> it reads `4JM5…` before approving anything. (Vault 0 is `8jj7…` and is empty.)

## Usage

```bash
cd scripts/deploy-merkle-trees/msig-fund
npm install            # or: bun install / yarn

# Fund just mSOL (preview first — sends nothing)
npm run fund -- \
  --config ../if-markets.mainnet.json \
  --multisig 7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM \
  --vault-index 1 \
  --keypair ~/.config/solana/proposer.json \
  --market mSOL --dry-run

# Drop --dry-run to actually create the proposal
npm run fund -- ... --vault-index 1 --market mSOL

# By index, or everything still unfunded
npm run fund -- ... --vault-index 1 --index 2
npm run fund -- ... --vault-index 1 --all
```

### Options

| flag | meaning |
|---|---|
| `--multisig <pubkey>` | Squads V4 multisig PDA (required) |
| `--keypair <path>` | proposer keypair, a multisig member (required) |
| `--config <path>` | IF config JSON (default `../if-markets.mainnet.json`) |
| `--market <symbol>` / `--index <n>` / `--all` | scope (pick one) |
| `--vault-index <n>` | Squads vault index (default `0`) |
| `--url <rpc>` | RPC override (default `config.rpc_url`) |
| `--trees-dir <dir>` | trees dir override (default `config.trees_dir`) |
| `--dry-run` | plan + print, send nothing |

> The vault PDA printed at startup must match the wallet that actually holds the
> tokens (`4JM5…`, which is vault index **1** for this multisig). If it doesn't,
> you have the wrong `--vault-index` or `--multisig`.

## Token-2022 direct distribution (`distribute-t22-msig.ts`)

The merkle-distributor program is **classic SPL Token only** (`Program<Token>` /
`token::TokenAccount`), so the Token-2022 IF mints can't be deployed as
distributors. Holder counts are tiny (77 total), so this script pays each holder
their CSV `amount` directly with a Token-2022 `transfer_checked` from the vault,
wrapped in Squads proposals.

Token-2022 markets: **PYUSD, AUSD, CASH, AI16Z, PUMP** (sACRED-4 has 0 holders).

Two phases — run `--create-atas` first, then propose:

```bash
cd scripts/deploy-merkle-trees/msig-fund && npm install

# Phase 1 (deployer-signed, NOT multisig): create missing destination ATAs.
# Idempotent; ~0.002 SOL rent each, paid by --keypair. Most holders already
# have an ATA, so this is mostly a no-op.
npm run distribute-t22 -- --config ../if-markets.mainnet.json \
  --keypair ~/.config/solana/id.json --all-t22 --create-atas

# Phase 2 (multisig): transfer_checked proposals from vault index 1 (4JM5…).
npm run distribute-t22 -- --config ../if-markets.mainnet.json \
  --multisig 7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM --vault-index 1 \
  --keypair ~/.config/solana/<member>.json --all-t22

# preview either phase:  --dry-run      single market:  --market PYUSD
```

Notes:
- Phase 2 **refuses** to propose if any destination ATA is missing — run
  `--create-atas` first. It also checks the vault holds enough of each mint.
- Transfers are chunked into proposals of `--batch-size` (default 10), so e.g.
  PYUSD's 40 holders become 4 proposals. Each is a normal Squads proposal the
  3-of-5 members approve + execute.
- `--keypair` for phase 2 must be a multisig **member** (it signs
  `proposalCreate`); for phase 1 it's just the rent payer.
- This is a one-shot distribution — re-running phase 2 creates **new** proposals
  (no on-chain idempotency). Don't approve duplicates.
