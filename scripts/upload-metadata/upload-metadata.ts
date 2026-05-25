/**
 * Uploads a token logo + off-chain metadata JSON to Arweave via Irys.
 *
 * Prints the final metadata URI to stdout (last line), so it can be captured
 * by a shell wrapper:
 *
 *   URI=$(yarn upload --keypair ... --image ... --name ... --symbol ... | tail -n1)
 *
 * All other progress logs go to stderr.
 *
 * Example command:
 *
 * bun upload-metadata.ts --keypair ~/.config/solana/id.json --cluster devnet --rpc https://api.devnet.solana.com --image ../../assets/dfx.svg --name DFX --symbol DFX
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseArgs } from "node:util";

import { createGenericFile, keypairIdentity } from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { irysUploader } from "@metaplex-foundation/umi-uploader-irys";

const { values } = parseArgs({
  options: {
    keypair: { type: "string", short: "k" },
    rpc: { type: "string", short: "u" },
    image: { type: "string", short: "i" },
    name: { type: "string", short: "n" },
    symbol: { type: "string", short: "s" },
    description: { type: "string", short: "d", default: "" },
    cluster: { type: "string", default: "mainnet" }, // "mainnet" or "devnet" — picks the Irys network
    help: { type: "boolean", short: "h" },
  },
});

if (
  values.help ||
  !values.keypair ||
  !values.rpc ||
  !values.image ||
  !values.name ||
  !values.symbol
) {
  console.error(`
Usage: ts-node upload-metadata.ts \\
  --keypair <path>          Funding/signing keypair (also pays Irys fees)
  --rpc <url>               Solana RPC URL
  --image <path>            Local image file (png/jpg/svg/gif/webp)
  --name <string>           Token name
  --symbol <string>         Token symbol
  [--description <string>]  Token description (default: "")
  [--cluster mainnet|devnet] Irys network (default: mainnet)

Notes:
  - Uses Irys (Arweave bundler). Pays in SOL from the provided keypair.
  - Files < 100 KiB on mainnet Irys are free; otherwise fund the keypair.
  - Prints the metadata URI as the final stdout line.
`);
  process.exit(values.help ? 0 : 1);
}

const log = (...args: unknown[]) => console.error("==>", ...args);

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const imagePath = values.image!;
const ext = extname(imagePath).toLowerCase();
const contentType = CONTENT_TYPES[ext];
if (!contentType) {
  console.error(
    `Unsupported image extension "${ext}". Supported: ${Object.keys(CONTENT_TYPES).join(", ")}`,
  );
  process.exit(1);
}

const cluster = values.cluster === "devnet" ? "devnet" : "mainnet";
log(`Cluster: ${cluster}`);
log(`RPC:     ${values.rpc}`);

const secretRaw = await readFile(values.keypair!, "utf8");
const secretKey = Uint8Array.from(JSON.parse(secretRaw));

const umi = createUmi(values.rpc!).use(
  irysUploader({
    address:
      cluster === "devnet"
        ? "https://devnet.irys.xyz"
        : "https://node1.irys.xyz",
  }),
);

const signer = umi.eddsa.createKeypairFromSecretKey(secretKey);
umi.use(keypairIdentity(signer));
log(`Payer:   ${signer.publicKey}`);

const imageBytes = await readFile(imagePath);
const imageFile = createGenericFile(
  imageBytes,
  imagePath.split("/").pop() ?? "logo",
  {
    contentType,
  },
);

log(`Uploading image (${imageBytes.length} bytes, ${contentType})...`);
const [imageUri] = await umi.uploader.upload([imageFile]);
log(`Image URI: ${imageUri}`);

const metadata = {
  name: values.name,
  symbol: values.symbol,
  description: values.description ?? "",
  image: imageUri,
};

log("Uploading metadata JSON...");
const metadataUri = await umi.uploader.uploadJson(metadata);
log(`Metadata URI: ${metadataUri}`);

// Final stdout line = metadata URI, for shell capture.
console.log(metadataUri);

process.exit(0);
