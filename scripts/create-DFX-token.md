# scripts

Tooling for creating the DFX token: upload off-chain metadata to Arweave, then create a vanity-address SPL Token mint with Metaplex metadata attached.

Two scripts, designed to be run in sequence:

1. [`upload-metadata/`](./upload-metadata) — uploads the logo image + off-chain JSON to Arweave via Irys (Metaplex Umi SDK). Outputs the metadata URI.
2. [`create-vanity-token.sh`](./create-vanity-token.sh) — grinds a vanity mint address, creates the SPL Token mint, attaches Metaplex Token Metadata pointing at the URI from step 1, mints the initial supply, and locks the mint authority.

## Prerequisites

CLI tools (must be on `PATH`):

- `solana`, `solana-keygen`, `spl-token` — install via [Solana Tool Suite](https://docs.solana.com/cli/install-solana-cli-tools).
- `metaboss` — `cargo install metaboss` (or `brew install metaboss`). Used by `create-vanity-token.sh` to attach on-chain Metaplex Token Metadata.
- `bun` — `curl -fsSL https://bun.sh/install | bash`. Runs the TypeScript uploader.

A funded Solana keypair:

- ~0.05 SOL minimum for token creation, ATA rent, metadata account rent, and tx fees.
- For Arweave uploads under 100 KiB on Irys mainnet, no extra balance is needed (free tier). Larger uploads will draw from the same keypair.

## Step 1 — Upload metadata to Arweave

Install deps once:

```bash
cd scripts/upload-metadata
bun install
cd -
```

Upload an image + JSON:

```bash
cd scripts/upload-metadata
bun upload \
  --keypair ~/.config/solana/id.json \
  --rpc https://api.mainnet-beta.solana.com \
  --image ../../assets/dfx.png \
  --name DFX \
  --symbol DFX \
  --description "DFX distributor token" \
  --cluster mainnet
```

Flags:

| Flag | Required | Notes |
|---|---|---|
| `--keypair` / `-k` | yes | Solana JSON keypair; pays Irys + signs uploads. |
| `--rpc` / `-u` | yes | Solana RPC URL (used by Umi; doesn't affect Arweave). |
| `--image` / `-i` | yes | Local image path. Supports png/jpg/jpeg/gif/webp/svg. |
| `--name` / `-n` | yes | Token name (written into the JSON). |
| `--symbol` / `-s` | yes | Token symbol (written into the JSON). |
| `--description` / `-d` | no | Optional description in JSON. |
| `--cluster` | no | `mainnet` (default) or `devnet`. **Devnet uploads do not land on `arweave.net` and are wiped every ~60 days — for throwaway testing only.** |

The final stdout line is the metadata URI (e.g. `https://arweave.net/<txid>`). Progress logs go to stderr.

**Mainnet propagation:** `arweave.net/<txid>` typically returns 502/404 for 10–60 minutes after upload while the gateway indexes the bundle. The Irys gateway (`https://gateway.irys.xyz/<txid>`) serves the file immediately. Use this to poll:

```bash
URI="https://arweave.net/<txid>"
until curl -fsI "$URI" >/dev/null 2>&1; do echo "waiting..."; sleep 60; done
```

Verify the URL returns the JSON (not the raw image):

```bash
curl -s "$URI"
# expect: {"name":"DFX","symbol":"DFX","description":"...","image":"https://arweave.net/<image-txid>"}
```

## Step 2 — Create the vanity-address mint

```bash
./scripts/create-vanity-token.sh \
  -k ~/.config/solana/id.json \
  -u mainnet-beta \
  -p dfx \
  -a 1000000 \
  -d 6 \
  -n DFX \
  -s DFX \
  -U https://arweave.net/<txid-from-step-1>
```

Flags:

| Flag | Required | Default | Notes |
|---|---|---|---|
| `-k` | yes | — | Payer + mint/freeze authority keypair. |
| `-u` | yes | — | RPC URL or moniker (`mainnet-beta` / `devnet` / `testnet` / `localhost`). |
| `-p` | yes | — | Vanity prefix for the mint address (case-sensitive base58). |
| `-a` | yes | — | UI amount to mint (decimals-adjusted). |
| `-n` | yes | — | Token name (on-chain Metaplex metadata, ≤ 32 chars). |
| `-s` | yes | — | Token symbol (on-chain Metaplex metadata, ≤ 10 chars). |
| `-U` | no | empty | Metadata URI from step 1. Empty = no image in wallets. |
| `-d` | no | 6 | Decimals. |
| `-o` | no | `./mint-keypairs` | Output dir for the generated mint keypair + sidecar. |

What it does, in order:

1. Checks balance and required binaries.
2. Grinds a vanity mint keypair via `solana-keygen grind --starts-with <prefix>:1`.
3. Creates the classic SPL Token mint with the vanity address (`spl-token create-token`).
4. Writes a metaboss payload JSON and calls `metaboss create metadata --immutable` to attach on-chain Metaplex metadata.
5. Creates the associated token account for the payer.
6. Mints the requested amount.
7. Verifies the wallet balance matches the requested amount; fails if not.
8. Disables the mint authority (fixed supply, irreversible).

Output files (in `-o`):

- `<MINT>.json` — the mint keypair. **Back this up** even after mint authority is disabled; it's the only authoritative record of the keypair.
- `<MINT>.metaboss.json` — the metaboss payload that was attached on-chain.

## End-to-end example (chained)

```bash
# 1. Upload to Arweave, capture URI.
URI=$(cd scripts/upload-metadata && bun upload \
  --keypair ~/.config/solana/id.json \
  --rpc https://api.mainnet-beta.solana.com \
  --image ../../assets/dfx.png \
  --name DFX --symbol DFX \
  --description "DFX distributor token" | tail -n1)

echo "Metadata URI: $URI"

# 2. Wait for arweave.net to serve it (mainnet only).
until curl -fsI "$URI" >/dev/null 2>&1; do echo "waiting for Arweave..."; sleep 60; done

# 3. Create the token.
./scripts/create-vanity-token.sh \
  -k ~/.config/solana/id.json \
  -u mainnet-beta \
  -p dfx -a 1000000 -d 6 \
  -n DFX -s DFX \
  -U "$URI"
```

## Things to know before running on mainnet

- **`--immutable` is set on metaboss.** The on-chain metadata (name, symbol, URI) cannot be changed afterwards. If you need to iterate on the image or JSON, remove `--immutable` from `create-vanity-token.sh` first — but ship without it.
- **Freeze authority is left enabled** (defaults to the payer). If you want a truly trustless token, add `--disable-freeze` to the `spl-token create-token` call.
- **Mint authority is disabled at the end.** This is irreversible — no further tokens can ever be minted. Make sure `-a` is the final intended supply.
- **Vanity prefix cost grows exponentially.** 3–4 chars: seconds. 5: minutes. 6+: hours. The script doesn't pre-estimate.
- **No priority fee.** On a congested mainnet you may want to add `--with-compute-unit-price` to the `spl-token` / `metaboss` calls.
- **Name/symbol drift.** `-n`/`-s` and the JSON's `name`/`symbol` should match. The on-chain Metaplex account is what wallets display for name/symbol; the JSON drives the image. Keep them in sync manually.

## Verifying the result

After `create-vanity-token.sh` finishes:

```bash
# Confirm the mint exists with correct decimals.
spl-token display <MINT> --url <RPC>

# Confirm Metaplex metadata.
metaboss decode mint --account <MINT> --rpc <RPC>

# Open in explorer (mainnet).
echo "https://explorer.solana.com/address/<MINT>"
```

Wallets like Phantom typically show name/symbol immediately and the image within a few minutes once `arweave.net` is serving the JSON.
