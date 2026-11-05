//! Burns every token held by the burner PDA.
//!
//! A token account owned by the PDA is a destination whose tokens only one action can
//! remove: `burn`, which anyone can call. The DFX distributors use such an account as
//! their clawback receiver, so a permissionless clawback followed by `burn` reduces supply.
//!
//! The program has no admin and no state. Deploy it without an upgrade authority.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface};
use solana_security_txt::security_txt;

declare_id!("burnhrRSRkbYBPbVWCVwMUxJMmVPtQqHBCUAVzkJ5tW");

pub const BURNER_SEED: &[u8] = b"burner";

security_txt! {
    // Required fields
    name: "Drift Token Burner",
    project_url: "https://www.drift.trade/",
    contacts: "email:security@drift.trade",
    policy: "https://github.com/drift-labs",
    // Optional Fields
    preferred_languages: "en",
    source_code: "https://github.com/drift-labs/dfx-distributor"
}

#[program]
pub mod token_burner {
    use super::*;

    /// Burns the full balance of a token account owned by the burner PDA.
    /// A zero balance is not an error, so a crank can call it without a check.
    pub fn burn(ctx: Context<BurnAll>) -> Result<()> {
        let amount = ctx.accounts.token_account.amount;
        if amount == 0 {
            return Ok(());
        }

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.token_account.to_account_info(),
                    authority: ctx.accounts.burner.to_account_info(),
                },
            )
            .with_signer(&[&[BURNER_SEED, &[ctx.bumps.burner]]]),
            amount,
        )?;

        emit!(BurnEvent {
            mint: ctx.accounts.mint.key(),
            token_account: ctx.accounts.token_account.key(),
            amount,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct BurnAll<'info> {
    /// CHECK: holds no data. It only signs the burn.
    #[account(seeds = [BURNER_SEED], bump)]
    pub burner: UncheckedAccount<'info>,

    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = burner,
        token::token_program = token_program,
    )]
    pub token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct BurnEvent {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub amount: u64,
}
