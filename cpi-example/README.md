# CPI Example: Claiming DFX From a Program

Many DFX claimants are *programs*, not wallets — the program itself owned the bad debt, so
the program's address (a PDA) is the claimant in the merkle tree. The distributor's
`new_claim` instruction requires the claimant to **sign**, which a program does by claiming
via CPI and signing with the PDA's seeds.

> **Not audited — reference only.** This example exists to show you what to implement in
> your own program. Don't deploy it as-is in place of your program: adapt your existing
> program using the CPI pattern shown here, audit your changes, and deploy that.

This folder is a complete, working example:

- [`programs/bad-debt-example`](programs/bad-debt-example/src/lib.rs) — an Anchor program
  whose `["bad_debt"]` PDA is entitled to DFX, with instructions to claim it and an
  admin-gated `withdraw` to move it out.
- [`scripts/`](scripts) — admin scripts that fetch the proof from the distributor API and
  run the claim/withdraw against a live cluster.
- [`tests/`](tests) — a [litesvm](https://github.com/LiteSVM/litesvm) test that stands up a
  local distributor with debt allocated to the PDA and proves the whole flow end to end.

## The pattern

1. **The claimant is a PDA of your program.** It goes
   into the merkle tree exactly like a wallet claimant. Here it's
   `find_program_address(["bad_debt"], program_id)`.
2. **The PDA signs via CPI.** `claim_dfx` calls `merkle_distributor::cpi::new_claim` with
   `CpiContext::new_with_signer`, passing the PDA as `claimant`.
3. **Rent comes from a separate payer, not the PDA.** `new_claim` hardcodes
   `payer = claimant` for the ClaimStatus account, but Anchor's `init` only debits the
   shortfall to rent exemption. `claim_dfx` therefore takes a normal `payer: Signer` and
   pre-funds the ClaimStatus address (~0.0017 SOL) before the CPI, so the claimant PDA
   never transfers lamports. This matters if your claimant PDA carries data: system
   transfers from data-bearing accounts fail, so a data-bearing PDA could never pay the
   rent itself. If your signer is a system account that has rent, you can avoid this step.
4. **Tokens land in the PDA's ATA.** The distributor enforces `to.owner == claimant`, so
   the destination is the PDA's associated token account (created with
   `allowOwnerOffCurve`). The admin-gated `withdraw` then transfers out of it, again
   signed with the PDA's seeds.

## Layout

This folder is a self-contained Cargo/Anchor workspace so it doesn't interact with the
root workspace — the same shape your own repo would have. The only coupling is the
dependency on the distributor crate:

```toml
# in your repo, use the git dependency instead of the path:
merkle-distributor = { git = "https://github.com/velocity-exchange/multi-distributor", features = ["cpi"] }
```

## Build

Requires the same toolchain as the rest of this repo (anchor CLI 0.28.x, solana 1.16+ CLI
tooling, rustc pinned by the repo's `rust-toolchain.toml`).

```sh
# 1. build the distributor (produces target/deploy/merkle_distributor.so for the tests)
anchor build          # at the repo root

# 2. build this example
cd cpi-example
anchor build
```

## Test (litesvm)

The tests run entirely in-process against litesvm — no validator, no RPC, no network.

```sh
cd cpi-example
yarn install
yarn test
```

Because `new_distributor` requires a hardcoded admin signer, the test injects the
`MerkleDistributor` account (and funded vault) directly with `svm.setAccount`, using a
two-leaf merkle tree containing the bad debt PDA. See [`tests/helpers.ts`](tests/helpers.ts).

## Mainnet usage

These scripts work against a live cluster, but remember: this program is not audited. The
recommended path is to adapt the CPI pattern into your own program, audit the changes, and
deploy that — then use these scripts as a template for your own tooling.

```sh
# one-time: create the config account; the signing keypair becomes the withdraw admin
yarn initialize --keypair ~/.config/solana/admin.json --rpc-url <RPC>

# claim: fetches the PDA's proof from the distributor API, then claims via CPI.
# Permissionless — the keypair just pays fees and the ClaimStatus rent. One run
# claims the full entitlement.
yarn claim --keypair ~/.config/solana/payer.json --rpc-url <RPC> \
  --api-url https://<distributor-api> [--api-user <user> --api-password <pass>]

# withdraw: admin only; defaults to the full balance of every token account the PDA owns
yarn withdraw --keypair ~/.config/solana/admin.json --rpc-url <RPC> \
  --destination <wallet pubkey> [--amount <base units>]
```

## Adapting this to your program

- Replace the `["bad_debt"]` seeds with whatever PDA actually owned the bad debt (the
  address registered in the merkle tree). The PDA may be an existing data-bearing account;
  nothing here requires it to be empty.
- Replace the `Config`/admin model with your program's existing admin/authority checks.
- If you claim from a wallet instead of a program, you don't need any of this — use
  `@velocity-exchange/merkle-distributor-sdk` (see [`ts-sdk/`](../ts-sdk)).
