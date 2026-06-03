#!/usr/bin/env python3
"""Convert Insurance Fund snapshot CSVs into deploy-ready merkle-tree CSVs.

Source (one file per spot market, produced by the IF snapshot tooling):

    dfx-calculation/insurance-fund/snapshots/<index>_<symbol>.csv

with columns:

    authority,marketIndex,stakePubkey,ifShares,ifBase,effectiveShares,
    tokenAmount,tokenAmountUi,costBasis,lastWithdrawRequestShares,
    lastWithdrawRequestValue,lastWithdrawRequestTs

`tokenAmount` is the authority's IF balance in *raw on-chain base units* — which
is exactly what the deploy scripts want, since deploy_market() always generates
trees in base-unit mode (`--csv-amount-unit tokens --decimals 0`). No scaling is
applied here.

Output (one file per market, consumed by deploy-if.sh):

    <out-dir>/<index>-<symbol>.csv      # note: dash, not underscore

with columns:

    pubkey,amount,locked_amount

One row per authority (rows are summed if an authority appears more than once in
a market file), `amount = sum(tokenAmount)`, `locked_amount = 0`. Rows with a
non-positive total are dropped — a zero/negative entitlement is not claimable.

The output filename uses the `<index>-<symbol>` convention deploy-if.sh expects
(it resolves each market to `<csv-dir>/<index>-<symbol>.csv`); the source uses
`<index>_<symbol>`, so the underscore before the symbol is rewritten to a dash.

Usage:
    ./prepare-if-csv.py --src <snapshots-dir> --out-dir <if-csv-dir>
    ./prepare-if-csv.py --src <snapshots-dir> --out-dir <if-csv-dir> --only 0,1,5
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

# Source filename: "<index>_<symbol>.csv" — index is leading digits, the rest
# (after the first underscore) is the symbol, which may itself contain
# underscores/dashes (e.g. "33_JLP-1.csv", "41_PT-fragSOL-10JUL25.csv").
NAME_RE = re.compile(r"^(?P<index>\d+)_(?P<symbol>.+)\.csv$")


def convert_file(src_path: Path, out_dir: Path) -> tuple[str, int, int, int]:
    """Convert one market snapshot. Returns (label, rows_in, rows_out, dropped)."""
    m = NAME_RE.match(src_path.name)
    if not m:
        raise ValueError(f"unexpected filename (want '<index>_<symbol>.csv'): {src_path.name}")
    index, symbol = m.group("index"), m.group("symbol")
    label = f"{index}-{symbol}"

    # Aggregate by authority: an authority with multiple stake accounts in one
    # market must appear once in the tree, with the summed amount.
    totals: dict[str, int] = {}
    rows_in = 0
    with src_path.open(newline="") as f:
        reader = csv.DictReader(f)
        required = {"authority", "tokenAmount"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{src_path.name} missing column(s): {', '.join(sorted(missing))}")
        for row in reader:
            rows_in += 1
            authority = row["authority"].strip()
            raw = row["tokenAmount"].strip()
            if not authority or not raw:
                continue
            # tokenAmount is an integer base-unit string; parse strictly.
            amount = int(raw)
            totals[authority] = totals.get(authority, 0) + amount

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{label}.csv"
    rows_out = 0
    dropped = 0
    with out_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["pubkey", "amount", "locked_amount"])
        for authority, amount in sorted(totals.items()):
            if amount <= 0:
                dropped += 1
                continue
            writer.writerow([authority, amount, 0])
            rows_out += 1

    return label, rows_in, rows_out, dropped


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", type=Path, required=True,
                        help="source snapshots dir (one <index>_<symbol>.csv per market)")
    parser.add_argument("--out-dir", type=Path, required=True,
                        help="output dir for deploy CSVs (<index>-<symbol>.csv per market)")
    parser.add_argument("--only", default=None,
                        help="comma-separated market indexes to convert (default: all)")
    args = parser.parse_args(argv)

    if not args.src.is_dir():
        print(f"error: source dir not found: {args.src}", file=sys.stderr)
        return 1

    only: set[str] | None = None
    if args.only:
        only = {tok.strip() for tok in args.only.split(",") if tok.strip()}

    src_files = sorted(
        (p for p in args.src.glob("*.csv") if NAME_RE.match(p.name)),
        key=lambda p: int(NAME_RE.match(p.name).group("index")),  # type: ignore[union-attr]
    )
    if not src_files:
        print(f"error: no '<index>_<symbol>.csv' files in {args.src}", file=sys.stderr)
        return 1

    print(f"==> IF CSV prep: {args.src} -> {args.out_dir}")
    converted = 0
    failed = 0
    for src_path in src_files:
        index = NAME_RE.match(src_path.name).group("index")  # type: ignore[union-attr]
        if only is not None and index not in only:
            continue
        try:
            label, rows_in, rows_out, dropped = convert_file(src_path, args.out_dir)
        except Exception as exc:  # noqa: BLE001 - surface per-file, keep going
            print(f"    [{src_path.name}] FAILED: {exc}", file=sys.stderr)
            failed += 1
            continue
        note = f" ({dropped} non-positive dropped)" if dropped else ""
        print(f"    [{label}] {rows_in} rows in -> {rows_out} claimants{note}")
        converted += 1

    print(f"==> Done: {converted} market(s) written, {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
