/**
 * Withdraw claimed DFX out of the bad debt PDA's token account. Admin only.
 *
 *   yarn withdraw --keypair ~/.config/solana/admin.json --destination <wallet pubkey> \
 *     [--amount <base units, default: full balance>] [--rpc-url ...] [--program-id ...]
 *
 * --destination is a wallet address; its ATA is created if needed. Pass
 * --destination-token-account to target an existing token account directly.
 */
import { BN } from '@coral-xyz/anchor';
import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

import { parseCommon } from './common';

const U64_MAX = new BN('18446744073709551615');

async function main() {
  const { connection, keypair, program, badDebtAuthority, config, values } = parseCommon({
    destination: { type: 'string' },
    'destination-token-account': { type: 'string' },
    amount: { type: 'string' },
  });

  // The PDA may hold balances of several mints (e.g. DFX IOU plus insurance fund mints);
  // find its token accounts and withdraw from each, or from the one matching --amount usage.
  const tokenAccounts = await connection.getTokenAccountsByOwner(badDebtAuthority, {
    programId: TOKEN_PROGRAM_ID,
  });
  if (tokenAccounts.value.length === 0) {
    throw new Error(`no token accounts owned by ${badDebtAuthority.toBase58()} — claim first`);
  }
  if (values.amount && tokenAccounts.value.length > 1) {
    throw new Error('--amount is ambiguous with multiple token accounts; withdraw all or specify per run');
  }

  const tx = new Transaction();
  for (const { pubkey, account } of tokenAccounts.value) {
    const decoded = AccountLayout.decode(account.data);
    const mint = new PublicKey(decoded.mint);
    if (decoded.amount === 0n) {
      console.log(`skipping ${pubkey.toBase58()} (mint ${mint.toBase58()}): empty`);
      continue;
    }

    let destination: PublicKey;
    if (values['destination-token-account']) {
      destination = new PublicKey(values['destination-token-account']);
    } else if (values.destination) {
      const destinationWallet = new PublicKey(values.destination);
      destination = getAssociatedTokenAddressSync(mint, destinationWallet, true);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          keypair.publicKey,
          destination,
          destinationWallet,
          mint,
        ),
      );
    } else {
      throw new Error('--destination <wallet> or --destination-token-account <token account> is required');
    }

    const amount = values.amount ? new BN(values.amount) : U64_MAX;
    console.log(
      `withdrawing ${values.amount ?? `all (${decoded.amount})`} of mint ${mint.toBase58()} to ${destination.toBase58()}`,
    );
    tx.add(
      await program.methods
        .withdraw(amount)
        .accounts({
          config,
          admin: keypair.publicKey,
          badDebtAuthority,
          from: pubkey,
          destination,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    );
  }

  if (tx.instructions.length === 0) {
    console.log('nothing to withdraw');
    return;
  }
  const signature = await sendAndConfirmTransaction(connection, tx, [keypair]);
  console.log(`signature: ${signature}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
