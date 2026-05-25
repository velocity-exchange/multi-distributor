# upload-metadata

Uploads a token logo image + the off-chain metadata JSON to Arweave via Irys, using the Metaplex Umi SDK. Pays in SOL from the provided keypair.

## Install

```bash
cd scripts/upload-metadata
bun install
```

## Use

```bash
bun upload \
  --keypair ~/.config/solana/id.json \
  --rpc https://api.mainnet-beta.solana.com \
  --image ../../assets/dfx.svg \
  --name DFX \
  --symbol DFX \
```

The metadata URI is printed as the final stdout line so you can pipe it:

```bash
URI=$(bun -s upload --keypair ... --rpc ... --image ... --name DFX --symbol DFX | tail -n1)
./scripts/create-vanity-token.sh -k ... -u ... -p dfx -a 1000000 -n DFX -s DFX -U "$URI"
```

## Costs

- Files under 100 KiB on Irys mainnet are free (you still sign, but no SOL is debited).
- Larger files: keep ~0.01 SOL on the keypair, or run `irys fund` separately first.
- For devnet testing, pass `--cluster devnet` — uploads land on Irys devnet (Arweave testnet) and may be wiped.
