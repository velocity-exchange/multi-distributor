/**
 * Claim this program's DFX allocation from the merkle distributor.
 *
 * Fetches the proof for the bad debt PDA from the distributor API, then sends claim_dfx
 * (creating the PDA's ATA if needed). One run claims the full entitlement.
 *
 *   yarn claim --keypair ~/.config/solana/payer.json --api-url https://<distributor-api> \
 *     [--rpc-url ...] [--program-id ...] [--api-user ... --api-password ...]
 *
 * Permissionless: the keypair only pays fees/rent; tokens always land in the PDA's ATA.
 */
import { BN } from '@coral-xyz/anchor';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

import {
  MERKLE_DISTRIBUTOR_PROGRAM_ID,
  deriveClaimStatus,
  fetchEligibility,
  parseCommon,
  selectEligibility,
} from './common';

async function main() {
  const { connection, keypair, program, badDebtAuthority, values } = parseCommon({
    'api-url': { type: 'string' },
    'api-user': { type: 'string' },
    'api-password': { type: 'string' },
    mint: { type: 'string' },
  });
  if (!values['api-url']) {
    throw new Error('--api-url <distributor api base url> is required');
  }

  console.log(`bad debt authority (claimant): ${badDebtAuthority.toBase58()}`);
  const eligibilities = await fetchEligibility(
    values['api-url'],
    badDebtAuthority,
    values['api-user'],
    values['api-password'],
  );
  const eligibility = selectEligibility(eligibilities, values.mint);

  const distributor = new PublicKey(eligibility.merkle_tree);
  const mint = new PublicKey(eligibility.mint);
  const vault = getAssociatedTokenAddressSync(mint, distributor, true);
  const badDebtAta = getAssociatedTokenAddressSync(mint, badDebtAuthority, true);
  const claimStatus = deriveClaimStatus(badDebtAuthority, distributor);

  console.log(`distributor: ${distributor.toBase58()}`);
  console.log(`allocation: ${eligibility.end_amount}`);

  if ((await connection.getAccountInfo(claimStatus)) !== null) {
    console.log('already claimed — nothing to do');
    return;
  }

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, badDebtAta, badDebtAuthority, mint),
    await program.methods
      .claimDfx(new BN(String(eligibility.end_amount)), eligibility.proof)
      .accounts({
        payer: keypair.publicKey,
        distributor,
        claimStatus,
        from: vault,
        to: badDebtAta,
        badDebtAuthority,
        merkleDistributorProgram: MERKLE_DISTRIBUTOR_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [keypair]);
  console.log(`signature: ${signature}`);
  const balance = await connection.getTokenAccountBalance(badDebtAta);
  console.log(`bad debt PDA token balance: ${balance.value.uiAmountString}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
