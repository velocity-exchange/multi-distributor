# Token Burner

An Anchor program with one instruction, `burn`. It burns the full balance of any token account that the burner PDA owns. Anyone can call it. The program has no admin and no state.

The DFX distributors use the burner's DFX account as their clawback receiver. `clawback` already accepts any signer, so after `clawback_start_ts` anyone can send one transaction with `clawback` and then `burn`. The unclaimed DFX then leaves the supply.

| | Address |
| --- | --- |
| Program | `burnhrRSRkbYBPbVWCVwMUxJMmVPtQqHBCUAVzkJ5tW` |
| Burner PDA (seed `"burner"`) | `CEPDSz19TJcBZHTJEpND8DPFHoXfodcn47VSXQEpBugk` |
| Burner DFX account (ATA of the PDA) | `C5fd7wHnqCbf12nXQ8UXUvCBwkgV1NDUZg74jG2TCvnh` |

The program keypair is not in this repo. Copy it to `target/deploy/token_burner-keypair.json` before a deploy.

## Build and test

```sh
cargo build-sbf --arch v3 --tools-version v1.57 --manifest-path programs/merkle-distributor/Cargo.toml
cargo build-sbf --arch v3 --tools-version v1.57 --manifest-path programs/token-burner/Cargo.toml
cd tests/token-burner && bun install && bun test
```

## Rollout

1. Deploy a verifiable build. Then set the upgrade authority and the IDL authority to the mainnet multisig vault `8jj7zJgdr5bDndc7evM74FMGwzLPmd4u4QxNzFi1BMai`.

2. Create the burner DFX account. Any wallet can pay for it:

   ```sh
   spl-token create-account dfxQsZjikuu5DGXPgX7yEpRog74HT5cJgytT3i5iLtw \
     --owner CEPDSz19TJcBZHTJEpND8DPFHoXfodcn47VSXQEpBugk
   ```

3. The distributor admin calls `set_clawback_receiver` on each DFX distributor with `C5fd7wHnqCbf12nXQ8UXUvCBwkgV1NDUZg74jG2TCvnh`. Read each distributor back and check `clawback_receiver`.

4. After `clawback_start_ts`, send `merkle_distributor::clawback` and `token_burner::burn` in one transaction for each distributor.

The distributor admin can still change `clawback_receiver` and `clawback_start_ts` after step 3. The burn is permissionless to trigger, but the admin can still stop it.

## Upgrades

A `program-token-burner-<version>` tag starts `release-program.yaml`. The workflow writes a verifiable build to a buffer and proposes the upgrade on the mainnet multisig. For devnet, run `manual-devnet-deploy.yaml` with `program: token_burner`.
