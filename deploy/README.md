# Deploying the DFX Distributor API

The API is a single Rust binary packaged as a Docker image. It:

- listens on `0.0.0.0:7001` (`api/src/main.rs`),
- loads every `*.json` Merkle tree in `MERKLE_TREE_PATH` **once at startup** (it
  does **not** watch the directory),
- subscribes to a Solana RPC + WS endpoint for live claim-status data,
- uses **no database** (despite `libpq-dev` in the Dockerfile).

There are two compose files, with different jobs:

| File | Job | Builds code? |
| --- | --- | --- |
| `../docker-compose.yaml` (repo root) | Build & tag the image (CI / your laptop) | Yes (`cargo build --release`) |
| `./docker-compose.yaml` (this dir) | **Run** a pre-built image on the server | No — pulls the image |

## Long-lived deployment: infra-v3 / EKS

For the production, long-lived service this API runs on Drift's EKS cluster via
`drift-labs/infrastructure-v3`, **not** the single-EC2 flow below. In that model:

- The image is built + pushed to Drift ECR by `.github/workflows/deploy-image.yml`
  (this repo) on push to `main` (devnet/`master` namespace) or a `v*` tag
  (mainnet-beta).
- Merkle trees are **not** in the image. Upload them to S3 and reload:
  ```sh
  scripts/upload-trees.sh master ./merkle-trees        # devnet
  kubectl rollout restart -n master deployment/dfx-distributor-api
  ```
- TLS, WAF, basic-auth, RPC creds, and autoscaling are owned by the infra-v3
  CDK stack `lib/stacks/dfx-distributor-stack.ts`.

The single-EC2 + docker-compose flow below remains valid for short-lived
rehearsals / one-off campaigns.

## Why trees are mounted, not committed

Tree JSON is **not** baked into the image and **should not** be committed
(`DEPLOY.md`, `MERKLE_TREES.md`). Trees change far more often than the binary,
carry per-user proof data, and the original prod setup mounted them from an EFS
volume. So: keep trees on the host (or EFS) and mount them read-only.

## 1. Build & push the image (CI or laptop — not the server)

```sh
# from the repo root
BUILD_TAG=v1.0.0 docker compose build

# tag + push to ECR (example)
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin 123456789012.dkr.ecr.us-east-1.amazonaws.com
docker tag driftlabs/dfx-distributor-api:v1.0.0 \
  123456789012.dkr.ecr.us-east-1.amazonaws.com/dfx-distributor-api:v1.0.0
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/dfx-distributor-api:v1.0.0
```

## 2. Prepare the EC2 host

```sh
# Amazon Linux 2023 (use apt-get on Ubuntu)
sudo dnf install -y docker
sudo systemctl enable --now docker

sudo mkdir -p /opt/dfx/merkle-trees
# copy the generated tree_*.json into /opt/dfx/merkle-trees (scp / aws s3 sync)
```

Security group: keep inbound **7001** closed to the internet — expose **443**
and put a reverse proxy / ALB in front (see step 5). Allow outbound **443** for
the RPC provider.

## 3. Configure

```sh
cd /opt/dfx
# place deploy/docker-compose.yaml and deploy/.env.example here
cp .env.example .env
$EDITOR .env          # fill in API_IMAGE, RPC_URL, WS_URL, MINT, PROGRAM_ID, ...
chmod 600 .env        # it holds the RPC key / auth creds
```

Point `MERKLE_TREE_HOST_DIR=/opt/dfx/merkle-trees` in `.env`.

## 4. Run

```sh
aws ecr get-login-password --region us-east-1 | docker login --username AWS ...   # so it can pull
docker compose pull
docker compose up -d
docker compose logs -f api    # confirm "loaded tree ..." lines and "starting server at 0.0.0.0:7001"
```

## 5. Front it with TLS

Don't expose raw 7001. Terminate HTTPS on 443 with nginx/Caddy on the box (or an
AWS ALB) forwarding to `127.0.0.1:7001`. Health-check the `/` route (returns 200,
no auth). The app's only built-in auth is HTTP basic auth, enabled by setting
**both** `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`.

---

## Updating to a new airdrop version

A new `airdrop_version` is a **new on-chain distributor**, not an edit. The full
chain operation lives in `../DEPLOY.md`; from the API's perspective the deploy
step is:

1. Generate the new tree with a non-colliding version (`cli create-merkle-tree
   --start-airdrop-version N`) — see `../MERKLE_TREES.md`.
2. Create + fund + verify the on-chain distributor (`../DEPLOY.md` §4–6).
3. Copy the new `tree_*.json` into the mounted dir:
   ```sh
   cp tree_1.json /opt/dfx/merkle-trees/
   ```
4. Restart so the API reloads all trees:
   ```sh
   docker compose -f /opt/dfx/docker-compose.yaml restart api
   ```

### Gotchas

- **Version collisions:** for the same mint, two trees must never share a
  version (PDA collision). Use distinct version ranges per asset/market bucket.
- **Same claimant in two trees:** the API keys proofs by claimant in one map
  (`api/src/router.rs`), so a wallet present in two trees in the same directory
  gets the **later-loaded** tree's proof — the earlier one is silently
  overwritten. Keep a claimant in at most one tree per directory, or run
  separate API instances/dirs per version.

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /` | none | Liveness check (returns 200) |
| `GET /distributors` | basic* | All known distributors |
| `GET /user/:pubkey` | basic* | Merkle proof for a claimant |
| `GET /claim/:pubkey` | basic* | On-chain claim status |
| `GET /eligibility/:pubkey` | basic* | Proof + computed claimable amounts |

\* Basic auth applies only when `BASIC_AUTH_USER` + `BASIC_AUTH_PASSWORD` are set.
