//! Example: a program that owns bad debt and is therefore entitled to DFX from the
//! merkle distributor.
//!
//! The distributor's `new_claim` requires the claimant to *sign*, so a program claims by
//! putting one of its PDAs in the merkle tree and signing the CPI with that PDA's seeds.
//! Tokens land in a token account owned by the PDA; an admin-gated `withdraw` moves them
//! out afterwards.

use anchor_lang::{prelude::*, system_program};
use anchor_spl::token::{self, Token, TokenAccount};
use merkle_distributor::{
    program::MerkleDistributor as MerkleDistributorProgram,
    state::{claim_status::ClaimStatus, merkle_distributor::MerkleDistributor},
};

declare_id!("3jFBjgMyNBTJwpELbmn6wyYJXDBZgRMYXcQMBywC9keV");

pub const CONFIG_SEED: &[u8] = b"config";
/// The claimant in the DFX merkle tree. A data-less authority PDA in this example, but
/// because `claim_dfx` covers the ClaimStatus rent from a separate payer, the same flow
/// works if your claimant PDA is an existing data-bearing account.
pub const BAD_DEBT_SEED: &[u8] = b"bad_debt";

#[program]
pub mod bad_debt_example {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.bump = *ctx.bumps.get("config").unwrap();
        Ok(())
    }

    /// Claim this program's DFX allocation.
    ///
    /// Permissionless crank: tokens can only land in the bad debt PDA's token account,
    /// so there is no benefit to restricting the caller. `amount` and `proof` come from
    /// the distributor API's `/eligibility/<bad_debt_pda>` endpoint (`end_amount`,
    /// `proof`); the amount can't be wrong, since it's part of the merkle leaf the proof
    /// is verified against.
    pub fn claim_dfx(ctx: Context<ClaimDfx>, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        // new_claim hardcodes `payer = claimant`, but Anchor's `init` only debits the
        // shortfall to rent exemption. Pre-funding the ClaimStatus address from a normal
        // signer means the claimant PDA never pays — required when the claimant PDA
        // carries data, since system transfers from data-bearing accounts fail.
        let required = Rent::get()?
            .minimum_balance(ClaimStatus::LEN)
            .saturating_sub(ctx.accounts.claim_status.lamports());
        if required > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.claim_status.to_account_info(),
                    },
                ),
                required,
            )?;
        }

        let bump = *ctx.bumps.get("bad_debt_authority").unwrap();
        let signer_seeds: &[&[u8]] = &[BAD_DEBT_SEED, &[bump]];
        merkle_distributor::cpi::new_claim(
            CpiContext::new_with_signer(
                ctx.accounts.merkle_distributor_program.to_account_info(),
                merkle_distributor::cpi::accounts::NewClaim {
                    distributor: ctx.accounts.distributor.to_account_info(),
                    claim_status: ctx.accounts.claim_status.to_account_info(),
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    claimant: ctx.accounts.bad_debt_authority.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            // amount_locked: DFX leaves are always fully unlocked.
            0,
            proof,
        )
    }

    /// Withdraw claimed DFX out of the bad debt PDA's token account. Admin only.
    /// Pass `u64::MAX` to withdraw the full balance.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let amount = if amount == u64::MAX {
            ctx.accounts.from.amount
        } else {
            amount
        };
        let bump = *ctx.bumps.get("bad_debt_authority").unwrap();
        let signer_seeds: &[&[u8]] = &[BAD_DEBT_SEED, &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.from.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.bad_debt_authority.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )
    }
}

#[account]
#[derive(Default)]
pub struct Config {
    pub admin: Pubkey,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 8 + 32 + 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// First caller wins; a real program would gate this on an upgrade authority or
    /// derive admin from existing state.
    #[account(
        init,
        seeds = [CONFIG_SEED],
        bump,
        space = Config::LEN,
        payer = admin
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimDfx<'info> {
    /// Pays the ClaimStatus rent (pre-funded so the claimant PDA never pays).
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub distributor: Account<'info, MerkleDistributor>,

    /// CHECK: PDA of ["ClaimStatus", bad_debt_authority, distributor] under the
    /// distributor program, which initializes and validates it.
    #[account(mut)]
    pub claim_status: UncheckedAccount<'info>,

    /// The distributor's vault.
    #[account(mut, address = distributor.token_vault)]
    pub from: Account<'info, TokenAccount>,

    /// Where the claimed DFX lands; must be owned by the bad debt PDA.
    #[account(
        mut,
        token::mint = distributor.mint,
        token::authority = bad_debt_authority
    )]
    pub to: Account<'info, TokenAccount>,

    /// CHECK: data-less authority PDA; the claimant in the merkle tree. Signs the CPI
    /// via seeds.
    #[account(mut, seeds = [BAD_DEBT_SEED], bump)]
    pub bad_debt_authority: UncheckedAccount<'info>,

    pub merkle_distributor_program: Program<'info, MerkleDistributorProgram>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,

    /// CHECK: authority PDA that owns the claimed tokens; signs the transfer via seeds.
    #[account(seeds = [BAD_DEBT_SEED], bump)]
    pub bad_debt_authority: UncheckedAccount<'info>,

    #[account(mut, token::authority = bad_debt_authority)]
    pub from: Account<'info, TokenAccount>,

    #[account(mut, token::mint = from.mint)]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Signer is not the configured admin")]
    Unauthorized,
}
