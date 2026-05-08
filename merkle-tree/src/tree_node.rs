use std::str::FromStr;

use serde::{Deserialize, Serialize};
use solana_program::{hash::hashv, pubkey::Pubkey};
use solana_sdk::hash::Hash;

use crate::{
    csv_amount_unit::{csv_amount_to_base_units, CsvAmountUnit},
    csv_entry::CsvEntry,
    error::MerkleTreeError,
};

/// Represents the claim information for an account.
#[derive(Debug, Clone, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub struct TreeNode {
    /// Pubkey of the claimant; will be responsible for signing the claim
    pub claimant: Pubkey,
    /// Amount that claimant can claim
    pub amount: u64,
    /// Locked amount
    pub locked_amount: Option<u64>,
    /// Claimant's proof of inclusion in the Merkle Tree
    pub proof: Option<Vec<[u8; 32]>>,
}

impl TreeNode {
    pub fn hash(&self) -> Hash {
        hashv(&[
            &self.claimant.to_bytes(),
            &self.amount.to_le_bytes(),
            &self.locked_amount.unwrap_or(0).to_le_bytes(),
        ])
    }

    /// Return total amount for this claimant
    pub fn total_amount(&self) -> u64 {
        self.amount
            .checked_add(self.locked_amount.unwrap_or(0))
            .unwrap()
    }

    /// Return amount for this claimant
    pub fn unlocked_amount(&self) -> u64 {
        self.amount
    }

    /// Return locked amount for this claimant
    pub fn locked_amount(&self) -> u64 {
        self.locked_amount.unwrap_or(0)
    }
}

impl TreeNode {
    /// Build a leaf from a CSV row. `mint_decimals` is the SPL mint precision (e.g. 6).
    pub fn from_csv(
        entry: CsvEntry,
        mint_decimals: u32,
        csv_amount_unit: CsvAmountUnit,
    ) -> Result<Self, MerkleTreeError> {
        let amount = csv_amount_to_base_units(entry.amount, mint_decimals, csv_amount_unit)?;
        let locked_amount = match entry.locked_amount {
            Some(la) => Some(csv_amount_to_base_units(la, mint_decimals, csv_amount_unit)?),
            None => None,
        };
        Ok(Self {
            claimant: Pubkey::from_str(entry.pubkey.as_str()).map_err(|_| {
                MerkleTreeError::AmountConversionError(format!("invalid pubkey {}", entry.pubkey))
            })?,
            amount,
            locked_amount,
            proof: None,
        })
    }
}
