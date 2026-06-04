#!/usr/bin/env python3
"""Convert the DFX notional snapshot into a deploy-ready merkle-tree CSV.

Source (one row per authority, produced by the dFx notional pipeline):

    dfx-calculation/dfx/dfx-snapshot.csv

with columns:

    authority,total_notional,borrow_lend_total,borrow_lend_breakdown,
    vaults_total,vaults_breakdown

`total_notional` is the authority's net entitlement expressed as **USD with 6
decimals** (e.g. "0.039929" == 0.039929 USD). The DFX IOU mint is a 6-decimal
token pegged 1:1 to USD notional, so the on-chain claim amount in base units is

    amount = round(total_notional * 10**decimals)        # decimals defaults to 6

Because the snapshot already prints exactly 6 fractional digits, the default
6-decimal conversion is exact (it is just the value with the decimal point
removed). Decimal arithmetic is used throughout so there is no float rounding.

Output (consumed by deploy-dfx.sh via its `csv_path`):

    <out-dir>/<symbol>.csv          # symbol defaults to "DFX"

with columns:

    pubkey,amount,locked_amount

One row per authority, `amount` as above, `locked_amount = 0`. Authorities with
a non-positive `total_notional` (zero or, rarely, negative) are dropped — they
have nothing claimable.

Usage:
    ./prepare-dfx-csv.py
    ./prepare-dfx-csv.py --src <snapshot.csv> --out-dir <dfx-csv-dir>
    ./prepare-dfx-csv.py --decimals 6 --symbol DFX
"""

from __future__ import annotations

import argparse
import csv
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

# Defaults wired to the on-disk layout so the script "just works" from anywhere.
DEFAULT_SRC = Path("/Users/chestersim/Desktop/dfx-calculation/dfx/dfx-snapshot.csv")
DEFAULT_OUT = Path(
    "/Users/chestersim/Desktop/multi-distributor/scripts/deploy-merkle-trees/dfx-csv"
)
DEFAULT_DECIMALS = 6  # DFX IOU mint decimals (README: "USD with 6 decimals").
DEFAULT_SYMBOL = "DFX"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", type=Path, default=DEFAULT_SRC,
                        help=f"source dfx-snapshot.csv (default: {DEFAULT_SRC})")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT,
                        help=f"output dir for the deploy CSV (default: {DEFAULT_OUT})")
    parser.add_argument("--symbol", default=DEFAULT_SYMBOL,
                        help=f"output filename stem, <symbol>.csv (default: {DEFAULT_SYMBOL})")
    parser.add_argument("--decimals", type=int, default=DEFAULT_DECIMALS,
                        help=f"DFX mint decimals for USD->base-unit scaling (default: {DEFAULT_DECIMALS})")
    args = parser.parse_args(argv)

    if not args.src.is_file():
        print(f"error: source file not found: {args.src}", file=sys.stderr)
        return 1
    if args.decimals < 0:
        print("error: --decimals must be >= 0", file=sys.stderr)
        return 1

    scale = Decimal(10) ** args.decimals
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_path = args.out_dir / f"{args.symbol}.csv"

    rows_in = 0
    rows_out = 0
    dropped_nonpos = 0
    dropped_fractional = 0
    dropped_min = 0
    total_base = 0

    with args.src.open(newline="") as fin, out_path.open("w", newline="") as fout:
        reader = csv.DictReader(fin)
        required = {"authority", "total_notional"}
        missing = required - set(reader.fieldnames or [])
        if missing:
            print(f"error: source missing column(s): {', '.join(sorted(missing))}", file=sys.stderr)
            return 1

        writer = csv.writer(fout)
        writer.writerow(["pubkey", "amount", "locked_amount"])

        for row in reader:
            rows_in += 1
            authority = (row["authority"] or "").strip()
            raw = (row["total_notional"] or "").strip()
            if not authority or not raw:
                dropped_nonpos += 1
                continue
            try:
                usd = Decimal(raw)
            except InvalidOperation:
                print(f"error: row {rows_in}: non-numeric total_notional {raw!r}", file=sys.stderr)
                return 1

            base = usd * scale
            # Guard against precision loss: if scaling leaves a fractional part,
            # the snapshot has more precision than `decimals` can represent.
            if base != base.to_integral_value():
                dropped_fractional += 1
                # Truncate toward zero rather than silently rounding up.
                base = base.to_integral_value(rounding="ROUND_DOWN")

            amount = int(base)
            if amount <= 0:
                dropped_nonpos += 1
                continue
            if amount < 10000:
                dropped_min += 1
                continue
            writer.writerow([authority, amount, 0])
            rows_out += 1
            total_base += amount

    print(f"==> DFX CSV prep: {args.src} -> {out_path}")
    print(f"    decimals={args.decimals}  rows_in={rows_in}  claimants={rows_out}")
    print(f"    dropped (non-positive): {dropped_nonpos}")
    if dropped_min:
        print(f"    dropped (< 10000 base units): {dropped_min}")
    if dropped_fractional:
        print(f"    WARNING: {dropped_fractional} row(s) had sub-base-unit precision "
              f"and were truncated (decimals={args.decimals} too coarse?)", file=sys.stderr)
    print(f"    total claimable: {total_base} base units "
          f"(~{Decimal(total_base) / scale} {args.symbol})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
