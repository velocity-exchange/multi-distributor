import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { IDL, BadDebtExample } from '../target/types/bad_debt_example';

export const MERKLE_DISTRIBUTOR_PROGRAM_ID = new PublicKey(
  'AtXLVASdFhmdq2KZxzhVFonmNXL76dTTsEABXySEHgLh',
);
export const DEFAULT_PROGRAM_ID = new PublicKey('3jFBjgMyNBTJwpELbmn6wyYJXDBZgRMYXcQMBywC9keV');

/** Shape returned by the distributor API's /eligibility/:pubkey endpoint. */
export interface EligibilityResp {
  claimant: string;
  merkle_tree: string;
  mint: string;
  start_ts: number;
  end_ts: number;
  proof: number[][];
  start_amount: string | number;
  end_amount: string | number;
  claimed_amount: string | number;
  locked_amount: string | number;
  claimable_amount: string | number;
  unlocked_amount_claimed: string | number;
  locked_amount_withdrawn: string | number;
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf-8'))));
}

export interface CommonContext {
  connection: Connection;
  keypair: Keypair;
  program: Program<BadDebtExample>;
  programId: PublicKey;
  badDebtAuthority: PublicKey;
  config: PublicKey;
  values: Record<string, string | undefined>;
}

/**
 * Parse shared CLI flags (--rpc-url, --keypair, --program-id) plus any script-specific
 * string options, and build the anchor program handle.
 */
export function parseCommon(extraOptions: Record<string, { type: 'string' }> = {}): CommonContext {
  const { values } = parseArgs({
    options: {
      'rpc-url': { type: 'string' },
      keypair: { type: 'string' },
      'program-id': { type: 'string' },
      ...extraOptions,
    },
  });

  if (!values.keypair) {
    throw new Error('--keypair <path to keypair json> is required');
  }
  const keypair = loadKeypair(values.keypair);
  const connection = new Connection(values['rpc-url'] ?? 'https://api.mainnet-beta.solana.com', 'confirmed');
  const programId = values['program-id'] ? new PublicKey(values['program-id']) : DEFAULT_PROGRAM_ID;
  const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment: 'confirmed' });
  const program = new Program<BadDebtExample>(IDL, programId, provider);

  const [badDebtAuthority] = PublicKey.findProgramAddressSync([Buffer.from('bad_debt')], programId);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);

  return { connection, keypair, program, programId, badDebtAuthority, config, values };
}

export function deriveClaimStatus(claimant: PublicKey, distributor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ClaimStatus'), claimant.toBuffer(), distributor.toBuffer()],
    MERKLE_DISTRIBUTOR_PROGRAM_ID,
  )[0];
}

export async function fetchEligibility(
  apiUrl: string,
  claimant: PublicKey,
  authUser?: string,
  authPassword?: string,
): Promise<EligibilityResp> {
  const headers = new Headers();
  if (authUser && authPassword) {
    headers.set('Authorization', 'Basic ' + Buffer.from(`${authUser}:${authPassword}`).toString('base64'));
  }
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/eligibility/${claimant.toBase58()}`, {
    headers,
  });
  const body = await response.json();
  if (response.status === 404 || (body as { error?: string }).error) {
    throw new Error(
      `claimant ${claimant.toBase58()} is not in the merkle tree: ${(body as { error?: string }).error ?? 'not found'}`,
    );
  }
  if (!response.ok) {
    throw new Error(`eligibility request failed with status ${response.status}: ${JSON.stringify(body)}`);
  }
  return body as EligibilityResp;
}
