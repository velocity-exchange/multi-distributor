/**
 * One-time setup: create the config account with the signing keypair as admin.
 *
 *   yarn initialize --keypair ~/.config/solana/admin.json [--rpc-url ...] [--program-id ...]
 */
import { SystemProgram } from '@solana/web3.js';

import { parseCommon } from './common';

async function main() {
  const { connection, keypair, program, config } = parseCommon();

  const existing = await connection.getAccountInfo(config);
  if (existing) {
    const decoded = await program.account.config.fetch(config);
    console.log(`config ${config.toBase58()} already initialized with admin ${decoded.admin.toBase58()}`);
    return;
  }

  const signature = await program.methods
    .initialize()
    .accounts({
      config,
      admin: keypair.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`initialized config ${config.toBase58()} with admin ${keypair.publicKey.toBase58()}`);
  console.log(`signature: ${signature}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
