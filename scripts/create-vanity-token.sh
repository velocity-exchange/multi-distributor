#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage: $0 -k <keypair> -u <rpc-url> -p <mint-prefix> -a <amount> -n <name> -s <symbol> [-d <decimals>] [-U <uri>] [-o <out-dir>]

  -k  Payer/authority keypair path
  -u  RPC URL (or moniker: mainnet-beta | devnet | testnet | localhost)
  -p  Vanity prefix for the mint address (case-sensitive, base58)
  -a  Amount of tokens to mint (UI amount, e.g. 1000000)
  -n  Token name (for on-chain metadata)
  -s  Token symbol (for on-chain metadata)
  -d  Decimals (default: 6)
  -U  Metadata URI (default: empty)
  -o  Output dir for the generated mint keypair (default: ./mint-keypairs)

Creates a classic SPL Token mint and attaches Metaplex Token Metadata
via metaboss. The `-U` URI must point to an already-uploaded off-chain
JSON file (which itself references the image URL); this script does NOT
upload the image or the JSON for you. Mint authority is disabled after
minting.

Off-chain JSON shape (host on Arweave/IPFS/HTTPS, then pass URL via -U):
  {
    "name": "DFX",
    "symbol": "DFX",
    "description": "...",
    "image": "https://.../logo.png"
  }

Example:
  $0 -k /Users/<user_name>/.config/solana/id.json -u devnet -p dfx -a 1000000 -d 6 -n DFX -s DFX
EOF
  exit 1
}

DECIMALS=6
OUT_DIR="./mint-keypairs"
URI=""

while getopts ":k:u:p:a:d:o:n:s:U:h" opt; do
  case "$opt" in
    k) KEYPAIR="$OPTARG" ;;
    u) RPC_URL="$OPTARG" ;;
    p) PREFIX="$OPTARG" ;;
    a) AMOUNT="$OPTARG" ;;
    d) DECIMALS="$OPTARG" ;;
    o) OUT_DIR="$OPTARG" ;;
    n) NAME="$OPTARG" ;;
    s) SYMBOL="$OPTARG" ;;
    U) URI="$OPTARG" ;;
    h|*) usage ;;
  esac
done

: "${KEYPAIR:?-k keypair is required}"
: "${RPC_URL:?-u rpc-url is required}"
: "${PREFIX:?-p prefix is required}"
: "${AMOUNT:?-a amount is required}"
: "${NAME:?-n name is required}"
: "${SYMBOL:?-s symbol is required}"

for bin in solana solana-keygen spl-token metaboss; do
  command -v "$bin" >/dev/null || { echo "Missing required binary: $bin" >&2; exit 1; }
done

if [[ -z "$URI" ]]; then
  echo "WARNING: -U (metadata URI) is empty. Metaplex metadata will be created with no URI," >&2
  echo "         so wallets/explorers will show name/symbol but no image or description." >&2
fi

[[ -f "$KEYPAIR" ]] || { echo "Keypair not found: $KEYPAIR" >&2; exit 1; }

# Normalize Solana CLI monikers to full URLs so non-Solana tools (metaboss) accept them too.
case "$RPC_URL" in
  mainnet-beta|mainnet|m) RPC_URL="https://api.mainnet-beta.solana.com" ;;
  devnet|d)               RPC_URL="https://api.devnet.solana.com" ;;
  testnet|t)              RPC_URL="https://api.testnet.solana.com" ;;
  localhost|localnet|l)   RPC_URL="http://127.0.0.1:8899" ;;
esac

mkdir -p "$OUT_DIR"

PAYER_PUBKEY="$(solana-keygen pubkey "$KEYPAIR")"
echo "==> Payer: $PAYER_PUBKEY"
echo "==> RPC:   $RPC_URL"

BALANCE_SOL="$(solana balance "$PAYER_PUBKEY" --url "$RPC_URL" | awk '{print $1}')"
echo "==> Payer balance: ${BALANCE_SOL} SOL"
awk -v b="$BALANCE_SOL" 'BEGIN { exit (b+0 >= 0.05) ? 0 : 1 }' \
  || { echo "Payer balance below 0.05 SOL; fund the wallet before continuing." >&2; exit 1; }

echo "==> Grinding for mint address starting with: $PREFIX"
GRIND_DIR="$(mktemp -d)"
pushd "$GRIND_DIR" >/dev/null
solana-keygen grind --starts-with "${PREFIX}:1" >/dev/null
MINT_KEYPAIR_FILE="$(ls -1 ./*.json | head -n1)"
MINT_PUBKEY="$(basename "$MINT_KEYPAIR_FILE" .json)"
popd >/dev/null

FINAL_MINT_KEYPAIR="${OUT_DIR}/${MINT_PUBKEY}.json"
mv "${GRIND_DIR}/${MINT_PUBKEY}.json" "$FINAL_MINT_KEYPAIR"
rmdir "$GRIND_DIR"
echo "==> Mint pubkey: $MINT_PUBKEY"
echo "==> Mint keypair saved to: $FINAL_MINT_KEYPAIR"

echo "==> Creating SPL Token mint (decimals=$DECIMALS)"
spl-token create-token \
  --url "$RPC_URL" \
  --fee-payer "$KEYPAIR" \
  --mint-authority "$PAYER_PUBKEY" \
  --decimals "$DECIMALS" \
  "$FINAL_MINT_KEYPAIR"

METADATA_SIDECAR="${OUT_DIR}/${MINT_PUBKEY}.metaboss.json"
cat >"$METADATA_SIDECAR" <<JSON
{
  "name": "$NAME",
  "symbol": "$SYMBOL",
  "uri": "$URI",
  "seller_fee_basis_points": 0,
  "creators": null
}
JSON
echo "==> Wrote metaboss payload: $METADATA_SIDECAR"

echo "==> Creating Metaplex Token Metadata via metaboss"
metaboss create metadata \
  --keypair "$KEYPAIR" \
  --rpc "$RPC_URL" \
  --mint "$MINT_PUBKEY" \
  --metadata "$METADATA_SIDECAR" \
  --immutable

echo "==> Creating associated token account for payer"
spl-token create-account \
  --url "$RPC_URL" \
  --fee-payer "$KEYPAIR" \
  --owner "$PAYER_PUBKEY" \
  "$MINT_PUBKEY"

echo "==> Minting $AMOUNT to $PAYER_PUBKEY"
spl-token mint \
  --url "$RPC_URL" \
  --fee-payer "$KEYPAIR" \
  --mint-authority "$KEYPAIR" \
  "$MINT_PUBKEY" "$AMOUNT"

echo "==> Verifying balance"
ACCOUNT_BALANCE="$(spl-token balance --url "$RPC_URL" --owner "$PAYER_PUBKEY" "$MINT_PUBKEY")"
echo "==> Wallet balance for $MINT_PUBKEY: $ACCOUNT_BALANCE"

if [[ "$ACCOUNT_BALANCE" != "$AMOUNT" ]]; then
  echo "ERROR: expected $AMOUNT, got $ACCOUNT_BALANCE" >&2
  exit 1
fi

echo "==> Disabling mint authority (fixed supply)"
spl-token authorize \
  --url "$RPC_URL" \
  --fee-payer "$KEYPAIR" \
  --authority "$KEYPAIR" \
  --disable \
  "$MINT_PUBKEY" mint

echo
echo "==> Done."
echo "    Mint:          $MINT_PUBKEY"
echo "    Mint keypair:  $FINAL_MINT_KEYPAIR"
echo "    Metaboss file: $METADATA_SIDECAR"
echo "    Name/Symbol:   $NAME / $SYMBOL (on-chain via Metaplex, immutable)"
echo "    Metadata URI:  ${URI:-<none>}"
echo "    Decimals:      $DECIMALS"
echo "    Minted:        $AMOUNT (mint authority disabled)"
echo "    Owner:         $PAYER_PUBKEY"
