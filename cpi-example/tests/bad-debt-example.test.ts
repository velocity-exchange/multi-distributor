import { BN } from '@coral-xyz/anchor';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MD_PROGRAM_ID,
  TestContext,
  exampleCoder,
  mdCoder,
  sendTx,
  sendTxExpectFail,
  setupSvm,
  tokenBalance,
} from './helpers';

const U64_MAX = new BN('18446744073709551615');

describe('bad-debt-example', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupSvm();
  });

  async function initializeIx(admin: PublicKey): Promise<TransactionInstruction> {
    return ctx.exampleProgram.methods
      .initialize()
      .accounts({
        config: ctx.config,
        admin,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async function claimDfxIx(): Promise<TransactionInstruction> {
    return ctx.exampleProgram.methods
      .claimDfx(new BN(ctx.allocation.toString()), ctx.proof)
      .accounts({
        payer: ctx.payer.publicKey,
        distributor: ctx.distributor,
        claimStatus: ctx.claimStatus,
        from: ctx.vault,
        to: ctx.badDebtAta,
        badDebtAuthority: ctx.badDebtAuthority,
        merkleDistributorProgram: MD_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  function createBadDebtAtaIx(): TransactionInstruction {
    return createAssociatedTokenAccountIdempotentInstruction(
      ctx.payer.publicKey,
      ctx.badDebtAta,
      ctx.badDebtAuthority,
      ctx.mint,
    );
  }

  async function claim(): Promise<void> {
    sendTx(ctx.svm, [createBadDebtAtaIx(), await claimDfxIx()], ctx.payer);
  }

  it('initializes the config with the signing admin', async () => {
    sendTx(ctx.svm, [await initializeIx(ctx.admin.publicKey)], ctx.admin);

    const account = ctx.svm.getAccount(ctx.config);
    expect(account).not.toBeNull();
    const config = exampleCoder.decode('config', Buffer.from(account!.data));
    expect(config.admin.equals(ctx.admin.publicKey)).toBe(true);
  });

  it('claims the full DFX allocation via CPI with the PDA as claimant', async () => {
    // The PDA holds no SOL: the ClaimStatus rent must come from the payer pre-funding.
    expect(ctx.svm.getBalance(ctx.badDebtAuthority) ?? 0n).toBe(0n);

    await claim();

    expect(tokenBalance(ctx.svm, ctx.badDebtAta)).toBe(ctx.allocation);
    expect(tokenBalance(ctx.svm, ctx.vault)).toBe(0n);

    const claimStatusAccount = ctx.svm.getAccount(ctx.claimStatus);
    expect(claimStatusAccount).not.toBeNull();
    const claimStatus = mdCoder.decode('claimStatus', Buffer.from(claimStatusAccount!.data));
    expect(claimStatus.claimant.equals(ctx.badDebtAuthority)).toBe(true);
    expect(claimStatus.unlockedAmountClaimed.toString()).toBe(ctx.allocation.toString());

    const distributorAccount = ctx.svm.getAccount(ctx.distributor);
    const distributor = mdCoder.decode('merkleDistributor', Buffer.from(distributorAccount!.data));
    expect(distributor.totalAmountClaimed.toString()).toBe(ctx.allocation.toString());
  });

  it('lets the admin withdraw the claimed DFX', async () => {
    sendTx(ctx.svm, [await initializeIx(ctx.admin.publicKey)], ctx.admin);
    await claim();

    const destinationWallet = Keypair.generate().publicKey;
    const destination = getAssociatedTokenAddressSync(ctx.mint, destinationWallet);
    const createDestinationIx = createAssociatedTokenAccountIdempotentInstruction(
      ctx.admin.publicKey,
      destination,
      destinationWallet,
      ctx.mint,
    );
    const withdrawIx = await ctx.exampleProgram.methods
      .withdraw(U64_MAX)
      .accounts({
        config: ctx.config,
        admin: ctx.admin.publicKey,
        badDebtAuthority: ctx.badDebtAuthority,
        from: ctx.badDebtAta,
        destination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    sendTx(ctx.svm, [createDestinationIx, withdrawIx], ctx.admin);

    expect(tokenBalance(ctx.svm, destination)).toBe(ctx.allocation);
    expect(tokenBalance(ctx.svm, ctx.badDebtAta)).toBe(0n);
  });

  it('rejects withdraw from a non-admin signer', async () => {
    sendTx(ctx.svm, [await initializeIx(ctx.admin.publicKey)], ctx.admin);
    await claim();

    const intruder = Keypair.generate();
    ctx.svm.airdrop(intruder.publicKey, 1_000_000_000n);
    const destination = getAssociatedTokenAddressSync(ctx.mint, intruder.publicKey);
    const createDestinationIx = createAssociatedTokenAccountIdempotentInstruction(
      intruder.publicKey,
      destination,
      intruder.publicKey,
      ctx.mint,
    );
    const withdrawIx = await ctx.exampleProgram.methods
      .withdraw(U64_MAX)
      .accounts({
        config: ctx.config,
        admin: intruder.publicKey,
        badDebtAuthority: ctx.badDebtAuthority,
        from: ctx.badDebtAta,
        destination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const failure = sendTxExpectFail(ctx.svm, [createDestinationIx, withdrawIx], intruder);
    // Custom error 6000 = Unauthorized (via the has_one override on config).
    expect(failure.meta().logs().join('\n')).toContain('Unauthorized');
    expect(tokenBalance(ctx.svm, ctx.badDebtAta)).toBe(ctx.allocation);
  });

  it('rejects a claim whose from account is not the distributor vault', async () => {
    const ix = await ctx.exampleProgram.methods
      .claimDfx(new BN(ctx.allocation.toString()), ctx.proof)
      .accounts({
        payer: ctx.payer.publicKey,
        distributor: ctx.distributor,
        claimStatus: ctx.claimStatus,
        from: ctx.badDebtAta, // not distributor.token_vault
        to: ctx.badDebtAta,
        badDebtAuthority: ctx.badDebtAuthority,
        merkleDistributorProgram: MD_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const failure = sendTxExpectFail(ctx.svm, [createBadDebtAtaIx(), ix], ctx.payer);
    expect(failure.meta().logs().join('\n')).toContain('ConstraintAddress');
  });

  it('rejects a claim with an invalid proof', async () => {
    const badProof = [Array.from(Buffer.alloc(32, 7))];
    const ix = await ctx.exampleProgram.methods
      .claimDfx(new BN(ctx.allocation.toString()), badProof)
      .accounts({
        payer: ctx.payer.publicKey,
        distributor: ctx.distributor,
        claimStatus: ctx.claimStatus,
        from: ctx.vault,
        to: ctx.badDebtAta,
        badDebtAuthority: ctx.badDebtAuthority,
        merkleDistributorProgram: MD_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const failure = sendTxExpectFail(ctx.svm, [createBadDebtAtaIx(), ix], ctx.payer);
    expect(failure.meta().logs().join('\n')).toContain('InvalidProof');
  });
});
