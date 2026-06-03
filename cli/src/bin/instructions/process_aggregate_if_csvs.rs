use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::*;

/// A single market entry from the IF config's `markets[]` array. Only the
/// fields the aggregation needs are typed; the rest of the config is preserved
/// verbatim as untyped JSON when emitting the merged config.
#[derive(Debug, Clone, Deserialize)]
pub struct IfMarket {
    pub index: u64,
    pub symbol: String,
    pub mint: String,
}

/// All markets sharing a single mint, collapsed into one deduped node set with
/// per-user `amount` and `locked_amount` summed across the source markets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedMint {
    pub mint: String,
    /// Symbol of the lowest-index source market (deterministic tie-break).
    pub symbol: String,
    /// Lowest source index, so the existing `<index>-<symbol>` label/dir
    /// convention used by deploy-if.sh / fund-if.sh keeps working unchanged.
    pub index: u64,
    /// Source market indices that fed this mint, for audit/logging only.
    pub source_markets: Vec<u64>,
    /// Deduped entries, sorted by pubkey for a reproducible merkle root and
    /// clean diffs. Guaranteed one row per claimant.
    pub entries: Vec<CsvEntry>,
}

/// Pure aggregation core: group `(market, entries)` inputs by mint and sum each
/// claimant's `amount` and `locked_amount` across same-mint markets.
///
/// This is the fix for the gap in `AirdropMerkleTree::new`, which combines
/// duplicate claimants by summing `amount` only and silently drops later
/// `locked_amount`s. Here we sum BOTH, so the merged CSV is correct and the
/// builder's own combine becomes a no-op on already-deduped input.
///
/// Markets are grouped in first-seen order; within a group the lowest-index
/// market wins the symbol/index tie-break. Returns an error on an unparseable
/// pubkey or a `u64` overflow rather than producing silently-wrong totals.
pub fn aggregate_if_entries(
    inputs: &[(IfMarket, Vec<CsvEntry>)],
) -> std::result::Result<Vec<MergedMint>, String> {
    // mint -> (representative market, accumulated per-pubkey sums). The outer
    // BTreeMap orders groups by mint and the inner one orders claimants by
    // pubkey, so the whole output is deterministic and diffs stay clean.
    let mut groups: BTreeMap<String, (IfMarket, BTreeMap<String, (u64, u64)>)> = BTreeMap::new();

    for (market, entries) in inputs {
        let group = groups
            .entry(market.mint.clone())
            .or_insert_with(|| (market.clone(), BTreeMap::new()));

        // Lowest-index market wins symbol/index; warn on a symbol mismatch
        // (same mint, different label) instead of silently picking one. Capture
        // the kept symbol BEFORE any swap, else a lower-index market overwrites
        // group.0 first and the comparison becomes market.symbol vs itself,
        // silently suppressing the warning when markets arrive index-ascending.
        let prev_symbol = group.0.symbol.clone();
        if market.index < group.0.index {
            group.0 = market.clone();
        }
        if market.symbol != prev_symbol {
            eprintln!(
                "WARNING: mint {} has conflicting symbols ('{}' vs '{}'); using '{}'",
                market.mint, prev_symbol, market.symbol, group.0.symbol
            );
        }

        for entry in entries {
            // Reject bad data up front; a malformed pubkey must not slip into a
            // tree that funds real claims.
            if Pubkey::from_str(&entry.pubkey).is_err() {
                return Err(format!(
                    "market {}-{}: invalid pubkey '{}'",
                    market.index, market.symbol, entry.pubkey
                ));
            }

            let acc = group.1.entry(entry.pubkey.clone()).or_insert((0, 0));
            acc.0 = acc.0.checked_add(entry.amount).ok_or_else(|| {
                format!(
                    "amount overflow for claimant {} on mint {}",
                    entry.pubkey, market.mint
                )
            })?;
            acc.1 = acc
                .1
                .checked_add(entry.locked_amount.unwrap_or(0))
                .ok_or_else(|| {
                    format!(
                        "locked_amount overflow for claimant {} on mint {}",
                        entry.pubkey, market.mint
                    )
                })?;
        }
    }

    let mut merged = Vec::with_capacity(groups.len());
    for (mint, (rep, sums)) in groups {
        let mut source_markets: Vec<u64> = inputs
            .iter()
            .filter(|(m, _)| m.mint == mint)
            .map(|(m, _)| m.index)
            .collect();
        source_markets.sort_unstable();

        let entries = sums
            .into_iter()
            .map(|(pubkey, (amount, locked))| CsvEntry {
                pubkey,
                amount,
                locked_amount: Some(locked),
            })
            .collect();

        merged.push(MergedMint {
            mint,
            symbol: rep.symbol,
            index: rep.index,
            source_markets,
            entries,
        });
    }

    Ok(merged)
}

/// Resolve the per-market CSV path: `<csv_dir>/<index>-<symbol>.csv`, matching
/// the convention used by deploy-if.sh.
fn market_csv_path(csv_dir: &Path, market: &IfMarket) -> PathBuf {
    csv_dir.join(format!("{}-{}.csv", market.index, market.symbol))
}

pub fn process_aggregate_if_csvs(aggregate_args: &AggregateIfCsvsArgs) {
    let raw = fs::read_to_string(&aggregate_args.config)
        .unwrap_or_else(|e| panic!("failed to read config {:?}: {}", aggregate_args.config, e));
    let mut config: Value = serde_json::from_str(&raw).expect("config is not valid JSON");

    let markets: Vec<IfMarket> = serde_json::from_value(
        config
            .get("markets")
            .cloned()
            .expect("config missing markets[]"),
    )
    .expect("markets[] entries must each have index, symbol, mint");
    assert!(!markets.is_empty(), "config has no markets[]");

    // CSV dir precedence: CLI flag > config.csv_dir. Mirrors deploy-if.sh.
    let csv_dir: PathBuf = aggregate_args
        .csv_dir
        .clone()
        .or_else(|| {
            config
                .get("csv_dir")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .expect("no csv-dir: pass --csv-dir or set csv_dir in the config");

    // Read every market's CSV (hard error on missing — a missing market would
    // silently understate a user's combined claim).
    let mut inputs: Vec<(IfMarket, Vec<CsvEntry>)> = Vec::with_capacity(markets.len());
    for market in &markets {
        let path = market_csv_path(&csv_dir, market);
        let entries = CsvEntry::new_from_file(&path)
            .unwrap_or_else(|e| panic!("failed to read {:?}: {:?}", path, e));
        inputs.push((market.clone(), entries));
    }

    let merged =
        aggregate_if_entries(&inputs).unwrap_or_else(|e| panic!("aggregation failed: {}", e));

    // Write one deduped CSV per unique mint into the output dir.
    fs::create_dir_all(&aggregate_args.out_csv_dir)
        .unwrap_or_else(|e| panic!("failed to create {:?}: {}", aggregate_args.out_csv_dir, e));

    let mut merged_markets: Vec<Value> = Vec::with_capacity(merged.len());
    for m in &merged {
        let label = format!("{}-{}", m.index, m.symbol);
        let out_path = aggregate_args.out_csv_dir.join(format!("{}.csv", label));

        let mut wtr = Writer::from_path(&out_path)
            .unwrap_or_else(|e| panic!("failed to write {:?}: {}", out_path, e));
        wtr.write_record(["pubkey", "amount", "locked_amount"])
            .unwrap();
        for entry in &m.entries {
            wtr.write_record([
                entry.pubkey.clone(),
                entry.amount.to_string(),
                entry.locked_amount.unwrap_or(0).to_string(),
            ])
            .unwrap();
        }
        wtr.flush().unwrap();

        println!(
            "==> {} <- markets {:?}: {} claimants",
            label,
            m.source_markets,
            m.entries.len()
        );

        merged_markets.push(json!({
            "index": m.index,
            "symbol": m.symbol,
            "mint": m.mint,
            "source_markets": m.source_markets,
        }));
    }

    // Emit a merged config: shared top-level fields preserved verbatim, markets[]
    // collapsed to one entry per mint, csv_dir pointed at the merged output so the
    // config is self-contained for deploy-if.sh / fund-if.sh.
    config["markets"] = Value::Array(merged_markets);
    config["csv_dir"] = json!(aggregate_args.out_csv_dir.to_string_lossy());

    let pretty = serde_json::to_string_pretty(&config).unwrap();
    fs::write(&aggregate_args.out_config, pretty)
        .unwrap_or_else(|e| panic!("failed to write {:?}: {}", aggregate_args.out_config, e));

    println!(
        "==> {} market(s) -> {} unique mint(s); merged config: {:?}",
        markets.len(),
        merged.len(),
        aggregate_args.out_config
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn market(index: u64, symbol: &str, mint: &str) -> IfMarket {
        IfMarket {
            index,
            symbol: symbol.to_string(),
            mint: mint.to_string(),
        }
    }

    // A real base58 pubkey so the validation guard passes.
    const PK_A: &str = "4KFhG4roRexhFqttE3KZmHrwQrxThRyg5aLcs2WRXk1F";
    const PK_B: &str = "FLYqJsmJ5AGMxMxK3Qy1rSen4ES2dqqo6h51W3C1tYS";

    fn entry(pubkey: &str, amount: u64, locked: u64) -> CsvEntry {
        CsvEntry {
            pubkey: pubkey.to_string(),
            amount,
            locked_amount: Some(locked),
        }
    }

    #[test]
    fn sums_amount_and_locked_across_same_mint_markets() {
        let inputs = vec![
            (market(0, "USDC", "MINT_USDC"), vec![entry(PK_A, 100, 5)]),
            (market(10, "USDC", "MINT_USDC"), vec![entry(PK_A, 250, 7)]),
        ];

        let merged = aggregate_if_entries(&inputs).unwrap();

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].mint, "MINT_USDC");
        assert_eq!(merged[0].index, 0);
        assert_eq!(merged[0].source_markets, vec![0, 10]);
        assert_eq!(merged[0].entries.len(), 1);
        assert_eq!(merged[0].entries[0].amount, 350);
        // locked must be summed too — the bug this whole feature works around.
        assert_eq!(merged[0].entries[0].locked_amount, Some(12));
    }

    #[test]
    fn keeps_distinct_mints_separate() {
        let inputs = vec![
            (market(0, "USDC", "MINT_USDC"), vec![entry(PK_A, 100, 0)]),
            (market(1, "SOL", "MINT_SOL"), vec![entry(PK_A, 200, 0)]),
        ];

        let merged = aggregate_if_entries(&inputs).unwrap();

        assert_eq!(merged.len(), 2);
        let usdc = merged.iter().find(|m| m.mint == "MINT_USDC").unwrap();
        let sol = merged.iter().find(|m| m.mint == "MINT_SOL").unwrap();
        assert_eq!(usdc.entries[0].amount, 100);
        assert_eq!(sol.entries[0].amount, 200);
    }

    #[test]
    fn treats_none_locked_as_zero() {
        let inputs = vec![(
            market(0, "USDC", "MINT_USDC"),
            vec![CsvEntry {
                pubkey: PK_A.to_string(),
                amount: 100,
                locked_amount: None,
            }],
        )];

        let merged = aggregate_if_entries(&inputs).unwrap();
        assert_eq!(merged[0].entries[0].locked_amount, Some(0));
    }

    #[test]
    fn output_is_sorted_by_pubkey_and_deduped() {
        // PK_B sorts after PK_A ('4' < 'F'); feed B first to prove sorting.
        let inputs = vec![(
            market(0, "USDC", "MINT_USDC"),
            vec![entry(PK_B, 1, 0), entry(PK_A, 2, 0), entry(PK_A, 3, 0)],
        )];

        let merged = aggregate_if_entries(&inputs).unwrap();
        let pubkeys: Vec<&str> = merged[0]
            .entries
            .iter()
            .map(|e| e.pubkey.as_str())
            .collect();
        assert_eq!(pubkeys, vec![PK_A, PK_B]);
        // PK_A appeared twice in one market -> summed, single row.
        assert_eq!(merged[0].entries[0].amount, 5);
    }

    #[test]
    fn rejects_invalid_pubkey() {
        let inputs = vec![(
            market(0, "USDC", "MINT_USDC"),
            vec![entry("not-a-key", 1, 0)],
        )];
        assert!(aggregate_if_entries(&inputs).is_err());
    }

    #[test]
    fn errors_on_amount_overflow() {
        let inputs = vec![
            (
                market(0, "USDC", "MINT_USDC"),
                vec![entry(PK_A, u64::MAX, 0)],
            ),
            (market(10, "USDC", "MINT_USDC"), vec![entry(PK_A, 1, 0)]),
        ];
        assert!(aggregate_if_entries(&inputs).is_err());
    }
}
