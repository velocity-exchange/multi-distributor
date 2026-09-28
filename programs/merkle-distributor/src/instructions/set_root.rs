use anchor_lang::{context::Context, prelude::*, Accounts, Result};
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

use crate::{
    error::ErrorCode,
    state::{claimed_event::SetRootEvent, merkle_distributor::MerkleDistributor},
};

/// DFX mints (mainnet, devnet). Only their distributors can be re-rooted, so this
/// instruction can never burn any other token held by this program.
const DFX_MINTS: [Pubkey; 2] = [
    anchor_lang::solana_program::pubkey!("dfxQsZjikuu5DGXPgX7yEpRog74HT5cJgytT3i5iLtw"),
    anchor_lang::solana_program::pubkey!("dfxKL8VLUjLMCnFiJ57ZjrjGDiDMLRX8tHmg8biUV39"),
];

/// [merkle_distributor::set_root] accounts.
#[derive(Accounts)]
pub struct SetRoot<'info> {
    /// The [MerkleDistributor].
    #[account(mut)]
    pub distributor: Account<'info, MerkleDistributor>,

    /// Distributor ATA holding the unclaimed tokens.
    #[account(mut, address = distributor.token_vault)]
    pub token_vault: Account<'info, TokenAccount>,

    /// The distributor's mint, burned from.
    #[account(mut, address = distributor.mint)]
    pub mint: Account<'info, Mint>,

    /// Admin signer
    #[account(address = distributor.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,

    /// SPL [Token] program.
    pub token_program: Program<'info, Token>,
}

/// Replaces a paused DFX distributor's merkle root with one that owes less, and burns
/// the difference (`old max_total_claim - new_max_total_claim`) from the vault.
#[allow(clippy::result_large_err)]
pub fn handle_set_root(
    ctx: Context<SetRoot>,
    new_root: [u8; 32],
    expected_old_root: [u8; 32],
    expected_num_nodes_claimed: u64,
    new_max_total_claim: u64,
) -> Result<()> {
    let distributor = &ctx.accounts.distributor;
    let burn_amount = validate_set_root(
        distributor,
        ctx.accounts.token_vault.amount,
        expected_old_root,
        expected_num_nodes_claimed,
        new_max_total_claim,
    )?;

    let seeds = [
        b"MerkleDistributor".as_ref(),
        &distributor.mint.to_bytes(),
        &distributor.version.to_le_bytes(),
        &[distributor.bump],
    ];
    if burn_amount > 0 {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.distributor.to_account_info(),
                },
            )
            .with_signer(&[&seeds[..]]),
            burn_amount,
        )?;
    }

    let distributor = &mut ctx.accounts.distributor;
    emit!(SetRootEvent {
        distributor: distributor.key(),
        old_root: distributor.root,
        new_root,
        old_max_total_claim: distributor.max_total_claim,
        new_max_total_claim,
        burned: burn_amount,
    });
    distributor.root = new_root;
    distributor.max_total_claim = new_max_total_claim;

    Ok(())
}

/// Returns the amount to burn.
/// CHECK:
///     1. The distributor is for a DFX mint
///     2. The distributor has not been clawed back
///     3. Claims are paused (`enable_slot == u64::MAX`)
///     4. The root and claim count are the ones the caller built against, so no claim
///        landed between building the new tree and pausing
///     5. The new max only decreases, and still covers what was already claimed or forgone
///     6. The vault covers `max_total_claim - claimed`, so burning the decrease leaves
///        `new_max_total_claim - claimed`
/// The program can't see leaves: the caller must not cut a claimant that already claimed.
#[allow(clippy::result_large_err)]
fn validate_set_root(
    distributor: &MerkleDistributor,
    vault_amount: u64,
    expected_old_root: [u8; 32],
    expected_num_nodes_claimed: u64,
    new_max_total_claim: u64,
) -> Result<u64> {
    require!(
        DFX_MINTS.contains(&distributor.mint),
        ErrorCode::MintNotReRootable
    );
    require!(!distributor.clawed_back, ErrorCode::ClawbackAlreadyClaimed);
    require!(
        distributor.enable_slot == u64::MAX,
        ErrorCode::DistributorNotPaused
    );
    require!(
        distributor.root == expected_old_root,
        ErrorCode::RootMismatch
    );
    require!(
        distributor.num_nodes_claimed == expected_num_nodes_claimed,
        ErrorCode::ClaimCountMismatch
    );
    require!(
        new_max_total_claim <= distributor.max_total_claim,
        ErrorCode::MaxTotalClaimIncrease
    );
    let settled = distributor
        .total_amount_claimed
        .checked_add(distributor.total_amount_forgone)
        .ok_or(ErrorCode::ArithmeticError)?;
    require!(new_max_total_claim >= settled, ErrorCode::ExceededMaxClaim);

    require!(
        vault_amount >= distributor.max_total_claim - distributor.total_amount_claimed,
        ErrorCode::InsufficientUnlockedTokens
    );

    Ok(distributor.max_total_claim - new_max_total_claim)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD_ROOT: [u8; 32] = [7; 32];
    const MAX: u64 = 1_000_000;

    fn paused(claimed: u64, forgone: u64) -> MerkleDistributor {
        MerkleDistributor {
            mint: DFX_MINTS[0],
            root: OLD_ROOT,
            max_total_claim: MAX,
            total_amount_claimed: claimed,
            total_amount_forgone: forgone,
            enable_slot: u64::MAX,
            ..Default::default()
        }
    }

    fn assert_err(result: Result<u64>, expected: ErrorCode) {
        assert_eq!(result.unwrap_err(), expected.into());
    }

    #[test]
    fn burns_exactly_the_decrease() {
        let d = paused(100, 0);
        assert_eq!(
            validate_set_root(&d, MAX - 100, OLD_ROOT, d.num_nodes_claimed, 600_000).unwrap(),
            400_000
        );
        assert_eq!(
            validate_set_root(&d, MAX - 100, OLD_ROOT, d.num_nodes_claimed, MAX).unwrap(),
            0
        );
    }

    #[test]
    fn a_vault_donation_does_not_change_the_burn() {
        let d = paused(100, 0);
        assert_eq!(
            validate_set_root(&d, MAX - 100 + 1, OLD_ROOT, d.num_nodes_claimed, 600_000).unwrap(),
            400_000
        );
    }

    #[test]
    fn works_on_the_devnet_mint() {
        let d = MerkleDistributor {
            mint: DFX_MINTS[1],
            ..paused(0, 0)
        };
        assert!(validate_set_root(&d, MAX, OLD_ROOT, d.num_nodes_claimed, 1).is_ok());
    }

    #[test]
    fn rejects_other_mints() {
        let d = MerkleDistributor {
            mint: Pubkey::new_unique(),
            ..paused(0, 0)
        };
        assert_err(
            validate_set_root(&d, MAX, OLD_ROOT, d.num_nodes_claimed, 1),
            ErrorCode::MintNotReRootable,
        );
    }

    #[test]
    fn rejects_clawed_back() {
        let d = MerkleDistributor {
            clawed_back: true,
            ..paused(0, 0)
        };
        assert_err(
            validate_set_root(&d, MAX, OLD_ROOT, d.num_nodes_claimed, 1),
            ErrorCode::ClawbackAlreadyClaimed,
        );
    }

    #[test]
    fn rejects_unpaused() {
        let d = MerkleDistributor {
            enable_slot: 0,
            ..paused(0, 0)
        };
        assert_err(
            validate_set_root(&d, MAX, OLD_ROOT, d.num_nodes_claimed, 1),
            ErrorCode::DistributorNotPaused,
        );
    }

    #[test]
    fn rejects_stale_root() {
        let d = paused(0, 0);
        assert_err(
            validate_set_root(&d, MAX, [8; 32], d.num_nodes_claimed, 1),
            ErrorCode::RootMismatch,
        );
    }

    #[test]
    fn rejects_a_claim_after_the_tree_was_built() {
        let d = MerkleDistributor {
            num_nodes_claimed: 3,
            ..paused(0, 0)
        };
        assert_err(
            validate_set_root(&d, MAX, OLD_ROOT, 2, 1),
            ErrorCode::ClaimCountMismatch,
        );
    }

    #[test]
    fn rejects_increase() {
        let d = paused(0, 0);
        assert_err(
            validate_set_root(&d, MAX, OLD_ROOT, d.num_nodes_claimed, MAX + 1),
            ErrorCode::MaxTotalClaimIncrease,
        );
    }

    #[test]
    fn rejects_max_below_claimed_plus_forgone() {
        let d = paused(500, 100);
        assert_err(
            validate_set_root(&d, MAX - 500, OLD_ROOT, d.num_nodes_claimed, 599),
            ErrorCode::ExceededMaxClaim,
        );
        assert!(validate_set_root(&d, MAX - 500, OLD_ROOT, d.num_nodes_claimed, 600).is_ok());
    }

    #[test]
    fn rejects_underfunded_vault() {
        let d = paused(100, 0);
        assert_err(
            validate_set_root(&d, MAX - 101, OLD_ROOT, d.num_nodes_claimed, 600_000),
            ErrorCode::InsufficientUnlockedTokens,
        );
        assert_err(
            validate_set_root(&d, 10, OLD_ROOT, d.num_nodes_claimed, 600_000),
            ErrorCode::InsufficientUnlockedTokens,
        );
    }
}
