#!/usr/bin/env bash
# Upload generated Merkle trees to the DFX distributor S3 prefix consumed by
# the API initContainer on EKS. After upload, restart the deployment to reload.
#
# Usage: scripts/upload-trees.sh <env: master|mainnet-beta> <local-tree-dir>
set -euo pipefail

ENV="${1:?usage: upload-trees.sh <master|mainnet-beta> <local-tree-dir>}"
DIR="${2:?usage: upload-trees.sh <master|mainnet-beta> <local-tree-dir>}"
BUCKET="drift-dfx-distributor-trees"

case "$ENV" in
  master|mainnet-beta) ;;
  *) echo "env must be 'master' or 'mainnet-beta'"; exit 1 ;;
esac

if ! ls "$DIR"/tree_*.json >/dev/null 2>&1; then
  echo "no tree_*.json files in $DIR"; exit 1
fi

echo "Syncing $DIR -> s3://$BUCKET/$ENV/ (delete-extraneous, only tree_*.json)"
aws s3 sync "$DIR" "s3://$BUCKET/$ENV/" \
  --exclude "*" --include "tree_*.json" --delete --exact-timestamps

echo "Done. Now reload the API:"
echo "  kubectl rollout restart -n $ENV deployment/dfx-distributor-api"
