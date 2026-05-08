#!/usr/bin/env python3
"""Convert dfx-users.csv (authority + currency total_notional) to Merkle CLI CSV.

Output columns: pubkey, amount, locked_amount

amount is **integer USD cents** (2 decimal places of dollar notion preserved): $82.55 → 8255.
Uses Decimal end-to-end — no float rounding on currency parsing or aggregation.

Per-authority allocation = sum of **positive** notionals (Decimal), then cents =
quantize(total_dollars * 100) with HALF_UP. Rows with cents == 0 are omitted.

================================================================================
IMPORTANT — Merkle CLI (mint decimals e.g. 6):

  target/debug/cli create-merkle-tree ... --decimals 6 --csv-amount-unit cents

`--csv-amount-unit cents` scales CSV integers by 10^(decimals−2) so 8255 ⇒ 82.55 tokens.

locked_amount stays 0 for unlocked-only IOU trees.

Usage:
  python3 merkle-tree/convert_dfx_users_to_merkle.py \\
    [--input merkle-tree/dfx-users.csv] [--output merkle-tree/dfx-users-merkle.csv]
"""

from __future__ import annotations

import argparse
import csv
import re
from collections import defaultdict
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP


def parse_notional_decimal(val: object) -> Decimal:
    """Parse currency-like strings to Decimal; invalid → 0."""
    if val is None:
        return Decimal("0")
    s = str(val).strip().strip('"')
    s = re.sub(r"[\$,]", "", s)
    if not s:
        return Decimal("0")
    try:
        return Decimal(s)
    except InvalidOperation:
        return Decimal("0")


def dollars_to_cents_strict_positive(total_dollars: Decimal) -> int:
    """Half-up to integer cents; negative or zero totals → 0."""
    if total_dollars <= 0:
        return 0
    cents = (total_dollars * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(cents)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--input",
        default="merkle-tree/dfx-users.csv",
        help="Source CSV with authority,total_notional,...",
    )
    p.add_argument(
        "--output",
        default="merkle-tree/dfx-users-merkle.csv",
        help="Output CSV for create-merkle-tree",
    )
    args = p.parse_args()

    aggregated: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    skipped_empty = 0
    with open(args.input, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or "authority" not in reader.fieldnames:
            raise SystemExit(f"Missing 'authority' column; headers={reader.fieldnames}")
        for row in reader:
            pk = (row.get("authority") or "").strip()
            if not pk:
                skipped_empty += 1
                continue
            v = parse_notional_decimal(row.get("total_notional"))
            if v > 0:
                aggregated[pk] += v

    rows: list[tuple[str, int]] = []
    for pk, total_dollars in aggregated.items():
        cents = dollars_to_cents_strict_positive(total_dollars)
        if cents > 0:
            rows.append((pk, cents))
    rows.sort(key=lambda x: x[0])

    with open(args.output, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["pubkey", "amount", "locked_amount"])
        for pk, cents in rows:
            w.writerow([pk, cents, 0])

    total_cents = sum(c for _, c in rows)
    print(f"Wrote {args.output}: {len(rows)} claimants")
    print(f"  amount column = USD cents (integer); sum(amount)={total_cents} cents")
    print(f"  Use: create-merkle-tree --decimals <mint_decimals> --csv-amount-unit cents")
    print(f"Unique authorities with positive notionals: {len(aggregated)}")
    print(f"Skipped empty authority rows: {skipped_empty}")


if __name__ == "__main__":
    main()
