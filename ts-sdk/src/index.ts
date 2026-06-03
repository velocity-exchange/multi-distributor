import { AnchorProvider, BN, Program, Wallet } from '@coral-xyz/anchor';
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { MerkleDistributor, IDL } from '../../target/types/merkle_distributor';

/**
 * Canonical total DFX distribution — the source of truth for the supply constant.
 *
 * Derived from the actual mainnet distribution CSV (sum of the `amount` column),
 * not a hand-entered figure. Any doc/test referencing 290,000,000 is stale.
 *
 * - DFX_TOTAL_SUPPLY_BASE_UNITS: exact sum in on-chain base units (6-decimal mint).
 * - DFX_TOTAL_SUPPLY_UI: the same value as whole DFX (~263,250,131.94).
 */
export const DFX_TOTAL_SUPPLY_BASE_UNITS = new BN('263250131935926');
export const DFX_TOTAL_SUPPLY_UI = 263_250_131.94;

// On-chain token amounts are u64 and can exceed Number.MAX_SAFE_INTEGER (2^53 - 1).
// They are encoded as decimal strings in API responses and parsed into BN before use,
// so no precision is lost. Timestamps, slots, versions, and node counts stay `number`
// (well within the safe-integer range).

export interface UserProof {
  merkleTree: string;
  amount: string;
  proof: number[][];
}

export interface ClaimStatusResp {
  claimant: PublicKey;
  lockedAmount: string;
  lockedAmountWithdrawn: string;
  unlockedAmount: string;
  unlockedAmountClaimed: string;
  closable: boolean;
  distributor: PublicKey;
}

export interface EligibilityResp {
  claimant: string;
  merkle_tree: string;
  mint: string;
  start_ts: number;
  end_ts: number;
  proof: number[][];
  start_amount: string;
  end_amount: string;
  claimed_amount: string;
  unvested_amount: string;
  locked_amount: string;
  claimable_amount: string;
  unlocked_amount_claimed: string;
  locked_amount_withdrawn: string;
}

export interface UserNotFoundResp {
  error: string;
}

export interface MerkleDistributorResp {
  pubkey: string;
  version: number;
  mint: string;
  tokenVault: string;
  maxTotalClaim: string;
  maxNumNodes: number;
  totalAmountClaimed: string;
  totalAmountForgone: string;
  numNodesClaimed: number;
  start_ts: number;
  end_ts: number;
  clawbackStartTs: number;
  clawbackReceiver: string;
  admin: string;
  clawedBack: boolean;
  enableSlot: number;
  closable: boolean;
}

export const getOrCreateATAInstruction = async (
  tokenMint: PublicKey,
  owner: PublicKey,
  connection: Connection,
  allowOwnerOffCurve = true,
  payer = owner,
): Promise<[PublicKey, TransactionInstruction?]> => {
  let toAccount;
  try {
    toAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      tokenMint,
      owner,
      allowOwnerOffCurve,
    );
    const account = await connection.getAccountInfo(toAccount);
    if (!account) {
      const ix = Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        tokenMint,
        toAccount,
        owner,
        payer,
      );
      return [toAccount, ix];
    }
    return [toAccount, undefined];
  } catch (e) {
    /* handle error */
    console.error('Error::getOrCreateATAInstruction', e);
    throw e;
  }
};

export interface ClaimIxConfig {
  connection?: Connection;
  claimantWallet?: Wallet;
  provider?: AnchorProvider;

  distributorProgramId: PublicKey;
  userEligibility: EligibilityResp;
  ignoreTokenAccountCreation?: boolean;
}

export interface ClaimLockedIxConfig {
  connection?: Connection;
  claimantWallet?: Wallet;
  provider?: AnchorProvider;

  distributorProgramId: PublicKey;
  userEligibility: EligibilityResp;
  ignoreTokenAccountCreation?: boolean;
}

export default class MerkleDistributorAPI {
  static async getUserProof(
    baseUrl: string,
    userPubkey: PublicKey,
    authUsername?: string,
    authPassword?: string,
  ): Promise<UserProof> {
    const url = `${baseUrl}/user/${userPubkey.toBase58()}`;
    const headers = new Headers();
    if (authUsername && authPassword) {
      headers.set('Authorization', 'Basic ' + btoa(authUsername + ':' + authPassword));
    }
    const response = await fetch(url, { headers });
    return (await response.json()) as UserProof;
  }

  static async getClaimStatus(
    baseUrl: string,
    userPubkey: PublicKey,
    authUsername?: string,
    authPassword?: string,
  ): Promise<ClaimStatusResp> {
    const url = `${baseUrl}/claim/${userPubkey.toBase58()}`;
    const headers = new Headers();
    if (authUsername && authPassword) {
      headers.set('Authorization', 'Basic ' + btoa(authUsername + ':' + authPassword));
    }
    const response = await fetch(url, { headers });
    return (await response.json()) as ClaimStatusResp;
  }

  static async getEligibility(
    baseUrl: string,
    userPubkey: PublicKey,
    authUsername?: string,
    authPassword?: string,
  ): Promise<EligibilityResp | UserNotFoundResp> {
    const url = `${baseUrl}/eligibility/${userPubkey.toBase58()}`;
    const headers = new Headers();
    if (authUsername && authPassword) {
      headers.set('Authorization', 'Basic ' + btoa(authUsername + ':' + authPassword));
    }
    const response = await fetch(url, { headers });
    if (response.status === 200) {
      return (await response.json()) as EligibilityResp;
    } else if (response.status === 404) {
      return (await response.json()) as UserNotFoundResp;
    } else {
      return await response.json();
    }
  }

  static async getDistributors(
    baseUrl: string,
    authUsername?: string,
    authPassword?: string,
  ): Promise<MerkleDistributorResp[]> {
    const url = `${baseUrl}/distributors`;
    const headers = new Headers();
    if (authUsername && authPassword) {
      headers.set('Authorization', 'Basic ' + btoa(authUsername + ':' + authPassword));
    }
    const response = await fetch(url, { headers });
    return (await response.json()) as MerkleDistributorResp[];
  }

  /**
   * Calculate the amount claimable for a user based on their eligibility and the current time.
   * Uses BN arithmetic so u64 token amounts above Number.MAX_SAFE_INTEGER stay exact.
   * @param u The user's eligibility data
   * @param nowTs The current time in seconds
   * @returns The amount claimable for the user in raw base units (no decimals applied)
   */
  static calculateClaimableAmount(u: EligibilityResp, nowTs = Date.now() / 1000): BN {
    if (nowTs < u.start_ts) {
      return new BN(0);
    }
    if (nowTs > u.end_ts) {
      return new BN(0);
    }
    const startAmount = new BN(u.start_amount);
    const endAmount = new BN(u.end_amount);
    const elapsed = new BN(Math.floor(nowTs) - u.start_ts);
    const duration = new BN(u.end_ts - u.start_ts);
    // floor(((end - start) * elapsed) / duration + start)
    return endAmount.sub(startAmount).mul(elapsed).div(duration).add(startAmount);
  }

  static deriveClaimStatus(claimant: PublicKey, distributor: PublicKey, programId: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('ClaimStatus'), claimant.toBytes(), distributor.toBytes()],
      programId,
    );
  }

  static async getNewClaimIxs(config: ClaimIxConfig): Promise<TransactionInstruction[]> {
    let provider = config.provider;
    if (!provider && config.connection && config.claimantWallet) {
      provider = new AnchorProvider(config.connection, config.claimantWallet, {});
    } else if (!provider) {
      throw new Error('Must provide either an AnchorProvider or Connection and Wallet');
    }

    const program = new Program<MerkleDistributor>(IDL, config.distributorProgramId, provider);

    const user = config.userEligibility;
    const claimant = new PublicKey(user.claimant);
    const distributor = new PublicKey(user.merkle_tree);
    const mint = new PublicKey(user.mint);

    const [claimStatusPubKey, _] = MerkleDistributorAPI.deriveClaimStatus(
      claimant,
      distributor,
      config.distributorProgramId,
    );

    const ixs: TransactionInstruction[] = [];

    const [toATA, toATAIx] = await getOrCreateATAInstruction(mint, claimant, provider.connection, true, claimant);
    const [mdATA, mdATAIx] = await getOrCreateATAInstruction(mint, distributor, provider.connection, true, claimant);

    if (toATAIx && !config.ignoreTokenAccountCreation) {
      ixs.push(toATAIx);
    }
    if (mdATAIx && !config.ignoreTokenAccountCreation) {
      ixs.push(mdATAIx);
    }

    return [
      ...ixs,
      await program.methods
        .newClaim(new BN(user.end_amount), new BN(user.locked_amount), user.proof as any)
        .accounts({
          claimant,
          claimStatus: claimStatusPubKey,
          distributor,
          from: mdATA,
          to: toATA,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ];
  }

  static async getClaimLockedIxs(config: ClaimLockedIxConfig): Promise<TransactionInstruction[]> {
    let provider = config.provider;
    if (!provider && config.connection && config.claimantWallet) {
      provider = new AnchorProvider(config.connection, config.claimantWallet, {});
    } else if (!provider) {
      throw new Error('Must provide either an AnchorProvider or Connection and Wallet');
    }

    const program = new Program<MerkleDistributor>(IDL, config.distributorProgramId, provider);

    const user = config.userEligibility;
    const claimant = new PublicKey(user.claimant);
    const distributor = new PublicKey(user.merkle_tree);
    const mint = new PublicKey(user.mint);

    const [claimStatusPubKey, _] = MerkleDistributorAPI.deriveClaimStatus(
      claimant,
      distributor,
      config.distributorProgramId,
    );

    const ixs: TransactionInstruction[] = [];

    const [toATA, toATAIx] = await getOrCreateATAInstruction(mint, claimant, provider.connection, true, claimant);
    const [mdATA, mdATAIx] = await getOrCreateATAInstruction(mint, distributor, provider.connection, true, claimant);

    if (toATAIx && !config.ignoreTokenAccountCreation) {
      ixs.push(toATAIx);
    }
    if (mdATAIx && !config.ignoreTokenAccountCreation) {
      ixs.push(mdATAIx);
    }

    return [
      ...ixs,
      await program.methods
        .claimLocked()
        .accounts({
          claimant, //
          claimStatus: claimStatusPubKey, //
          distributor, //
          from: mdATA, //
          to: toATA, //
          tokenProgram: TOKEN_PROGRAM_ID, //
        })
        .instruction(),
    ];
  }
}
