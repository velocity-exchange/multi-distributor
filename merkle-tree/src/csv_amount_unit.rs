//! How CSV `amount` / `locked_amount` integers map to on-chain token base units.

use crate::error::MerkleTreeError;

/// Interpretation of integer amounts read from the claimant CSV.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CsvAmountUnit {
    /// Whole UI tokens: base = amount × 10^mint_decimals.
    #[default]
    Tokens,
    /// Cents of the UI token (2 decimal places): base = amount × 10^(mint_decimals − 2).
    /// Example: mint_decimals = 6, amount = 8255 ⇒ 82.55 tokens ⇒ 82_550_000 base units.
    Cents,
}

/// Scale a CSV integer amount to SPL base units for the given mint decimal count.
pub fn csv_amount_to_base_units(
    amount: u64,
    mint_decimals: u32,
    unit: CsvAmountUnit,
) -> Result<u64, MerkleTreeError> {
    match unit {
        CsvAmountUnit::Tokens => {
            let scale = 10u64.checked_pow(mint_decimals).ok_or_else(|| {
                MerkleTreeError::AmountConversionError(format!(
                    "mint decimals {} invalid for token scaling",
                    mint_decimals
                ))
            })?;
            amount.checked_mul(scale).ok_or_else(|| {
                MerkleTreeError::AmountConversionError(format!(
                    "overflow: amount {} × 10^{}",
                    amount, mint_decimals
                ))
            })
        }
        CsvAmountUnit::Cents => {
            if mint_decimals < 2 {
                return Err(MerkleTreeError::AmountConversionError(
                    "csv-amount-unit cents requires mint decimals >= 2".into(),
                ));
            }
            let exp = mint_decimals - 2;
            let scale = 10u64.checked_pow(exp).ok_or_else(|| {
                MerkleTreeError::AmountConversionError(format!(
                    "mint decimals {} invalid for cents scaling",
                    mint_decimals
                ))
            })?;
            amount.checked_mul(scale).ok_or_else(|| {
                MerkleTreeError::AmountConversionError(format!(
                    "overflow: {} cents × 10^{}",
                    amount, exp
                ))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cents_matches_ui_scaling_for_six_decimals() {
        let base = csv_amount_to_base_units(8255, 6, CsvAmountUnit::Cents).unwrap();
        assert_eq!(base, 82_550_000);
    }

    #[test]
    fn tokens_default_scaling() {
        let base = csv_amount_to_base_units(82, 6, CsvAmountUnit::Tokens).unwrap();
        assert_eq!(base, 82_000_000);
    }

    #[test]
    fn cents_requires_two_decimal_places() {
        assert!(csv_amount_to_base_units(1, 1, CsvAmountUnit::Cents).is_err());
    }
}
