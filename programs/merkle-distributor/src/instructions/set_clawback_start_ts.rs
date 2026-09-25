use anchor_lang::{context::Context, prelude::*, Accounts, Result};

use crate::{
    error::ErrorCode, instructions::new_distributor::SECONDS_PER_DAY,
    state::merkle_distributor::MerkleDistributor,
};

/// [merkle_distributor::set_clawback_start_ts] accounts.
#[derive(Accounts)]
pub struct SetClawbackStartTs<'info> {
    /// The [MerkleDistributor].
    #[account(mut)]
    pub distributor: Account<'info, MerkleDistributor>,

    /// Admin signer
    #[account(address = distributor.admin @ ErrorCode::Unauthorized)]
    pub admin: Signer<'info>,
}

/// Sets a new clawback start timestamp
#[allow(clippy::result_large_err)]
pub fn handle_set_clawback_start_ts(
    ctx: Context<SetClawbackStartTs>,
    clawback_start_ts: i64,
) -> Result<()> {
    let distributor = &mut ctx.accounts.distributor;

    validate_clawback_start_ts(distributor, clawback_start_ts, Clock::get()?.unix_timestamp)?;

    // Note: might get truncated, do not rely on
    msg!(
        "set clawback start from {} to {}",
        distributor.clawback_start_ts,
        clawback_start_ts
    );

    distributor.clawback_start_ts = clawback_start_ts;

    Ok(())
}

/// CHECK:
///     1. The distributor has not been clawed back
///     2. The new clawback start is in the future
///     3. The new clawback start is at least one day after vesting end
#[allow(clippy::result_large_err)]
fn validate_clawback_start_ts(
    distributor: &MerkleDistributor,
    clawback_start_ts: i64,
    curr_ts: i64,
) -> Result<()> {
    require!(!distributor.clawed_back, ErrorCode::ClawbackAlreadyClaimed);
    require!(
        clawback_start_ts > curr_ts,
        ErrorCode::TimestampsNotInFuture
    );
    require!(
        clawback_start_ts
            >= distributor
                .end_ts
                .checked_add(SECONDS_PER_DAY)
                .ok_or(ErrorCode::ArithmeticError)?,
        ErrorCode::InsufficientClawbackDelay
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn distributor(end_ts: i64, clawed_back: bool) -> MerkleDistributor {
        MerkleDistributor {
            end_ts,
            clawed_back,
            ..Default::default()
        }
    }

    fn assert_err(result: Result<()>, expected: ErrorCode) {
        assert_eq!(result.unwrap_err(), expected.into());
    }

    #[test]
    fn accepts_future_ts_a_day_after_vesting() {
        let d = distributor(NOW - 10, false);
        assert!(validate_clawback_start_ts(&d, NOW - 10 + SECONDS_PER_DAY, NOW).is_ok());
        assert!(validate_clawback_start_ts(&d, NOW + 365 * SECONDS_PER_DAY, NOW).is_ok());
    }

    #[test]
    fn rejects_clawed_back_distributor() {
        let d = distributor(NOW - SECONDS_PER_DAY * 2, true);
        assert_err(
            validate_clawback_start_ts(&d, NOW + SECONDS_PER_DAY, NOW),
            ErrorCode::ClawbackAlreadyClaimed,
        );
    }

    #[test]
    fn rejects_past_or_current_ts() {
        let d = distributor(NOW - SECONDS_PER_DAY * 2, false);
        assert_err(
            validate_clawback_start_ts(&d, NOW, NOW),
            ErrorCode::TimestampsNotInFuture,
        );
    }

    #[test]
    fn rejects_ts_within_a_day_of_vesting_end() {
        let d = distributor(NOW, false);
        assert_err(
            validate_clawback_start_ts(&d, NOW + SECONDS_PER_DAY - 1, NOW),
            ErrorCode::InsufficientClawbackDelay,
        );
    }

    #[test]
    fn rejects_overflowing_vesting_end() {
        let d = distributor(i64::MAX, false);
        assert_err(
            validate_clawback_start_ts(&d, i64::MAX, NOW),
            ErrorCode::ArithmeticError,
        );
    }
}
