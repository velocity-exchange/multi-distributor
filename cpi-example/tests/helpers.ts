import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AnchorProvider, BorshAccountsCoder, BN, Program, Wallet } from '@coral-xyz/anchor';
import type { Idl } from '@coral-xyz/anchor';
import { AccountLayout, MintLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from 'litesvm';

import { IDL as EXAMPLE_IDL, BadDebtExample } from '../target/types/bad_debt_example';
import { IDL as MD_IDL, MerkleDistributor } from '../../target/types/merkle_distributor';

const HERE = dirname(fileURLToPath(import.meta.url));

export const MD_PROGRAM_ID = new PublicKey('distAitdwx9mDm3SaPMtGZRjpXMPUenLhmPwoySV3Hp');
export const EXAMPLE_PROGRAM_ID = new PublicKey('3jFBjgMyNBTJwpELbmn6wyYJXDBZgRMYXcQMBywC9keV');

const MD_SO = resolve(HERE, '../../target/deploy/merkle_distributor.so');
const EXAMPLE_SO = resolve(HERE, '../target/deploy/bad_debt_example.so');

// Matches the litesvm clock we set in setupSvm().
export const NOW = 1_750_000_000;

export const mdCoder = new BorshAccountsCoder(MD_IDL as Idl);
export const exampleCoder = new BorshAccountsCoder(EXAMPLE_IDL as Idl);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

/** Leaf hash used by the distributor: sha256(0x00 || sha256(claimant || unlocked || locked)). */
export function leafNode(claimant: PublicKey, unlocked: bigint, locked: bigint): Buffer {
  const inner = sha256(claimant.toBuffer(), u64le(unlocked), u64le(locked));
  return sha256(Buffer.from([0]), inner);
}

/** Internal node hash: sha256(0x01 || min(a,b) || max(a,b)) — sorted pairs, see verify/src/lib.rs. */
export function hashPair(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return sha256(Buffer.from([1]), lo, hi);
}

export function deriveBadDebtAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('bad_debt')], EXAMPLE_PROGRAM_ID)[0];
}

export function deriveConfig(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], EXAMPLE_PROGRAM_ID)[0];
}

export function deriveDistributor(mint: PublicKey, version: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('MerkleDistributor'), mint.toBuffer(), u64le(version)],
    MD_PROGRAM_ID,
  );
}

export function deriveClaimStatus(claimant: PublicKey, distributor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ClaimStatus'), claimant.toBuffer(), distributor.toBuffer()],
    MD_PROGRAM_ID,
  )[0];
}

function setTokenAccount(svm: LiteSVM, address: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  svm.setAccount(address, {
    lamports: 2_100_000,
    data,
    owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    executable: false,
  });
}

function setMint(svm: LiteSVM, address: PublicKey, supply: bigint) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  svm.setAccount(address, {
    lamports: 1_500_000,
    data,
    owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    executable: false,
  });
}

export interface TestContext {
  svm: LiteSVM;
  payer: Keypair;
  admin: Keypair;
  mint: PublicKey;
  distributor: PublicKey;
  vault: PublicKey;
  badDebtAuthority: PublicKey;
  badDebtAta: PublicKey;
  config: PublicKey;
  claimStatus: PublicKey;
  proof: number[][];
  allocation: bigint;
  exampleProgram: Program<BadDebtExample>;
}

export async function setupSvm(): Promise<TestContext> {
  for (const [path, hint] of [
    [MD_SO, 'run `anchor build` at the repo root'],
    [EXAMPLE_SO, 'run `anchor build` in cpi-example/'],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`missing ${path} — ${hint}`);
    }
  }

  const svm = new LiteSVM();
  svm.addProgramFromFile(MD_PROGRAM_ID, MD_SO);
  svm.addProgramFromFile(EXAMPLE_PROGRAM_ID, EXAMPLE_SO);

  // LiteSVM's clock starts at unix timestamp 0; pin it so the distributor's claim
  // window below is deterministically open.
  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(NOW);
  svm.setClock(clock);

  const payer = Keypair.generate();
  const admin = Keypair.generate();
  svm.airdrop(payer.publicKey, 10_000_000_000n);
  svm.airdrop(admin.publicKey, 10_000_000_000n);

  const mint = Keypair.generate().publicKey;
  setMint(svm, mint, 1_000_000_000n);

  const badDebtAuthority = deriveBadDebtAuthority();
  const [distributor, distributorBump] = deriveDistributor(mint, 0n);
  const vault = getAssociatedTokenAddressSync(mint, distributor, true);
  const badDebtAta = getAssociatedTokenAddressSync(mint, badDebtAuthority, true);

  // Two-leaf tree: the bad debt PDA plus a dummy claimant, so the on-chain proof
  // verification actually walks a sibling (proof = [dummyLeaf]). Like the deployed DFX
  // trees, leaves carry the full entitlement as amount_unlocked with amount_locked = 0.
  const allocation = 1_000_000_000n;
  const ourLeaf = leafNode(badDebtAuthority, allocation, 0n);
  const dummyLeaf = leafNode(Keypair.generate().publicKey, 1_000n, 0n);
  const root = hashPair(ourLeaf, dummyLeaf);
  const proof = [Array.from(dummyLeaf)];

  // new_distributor requires a hardcoded admin signer we don't control, so inject the
  // distributor account directly instead of invoking the instruction.
  const distributorData = await mdCoder.encode('merkleDistributor', {
    bump: distributorBump,
    version: new BN(0),
    root: Array.from(root),
    mint,
    tokenVault: vault,
    maxTotalClaim: new BN(2_000_000_000),
    maxNumNodes: new BN(2),
    totalAmountClaimed: new BN(0),
    totalAmountForgone: new BN(0),
    numNodesClaimed: new BN(0),
    // 1-second window in the past, mirroring the deployed config
    // (deploy-common.sh enforces end_vesting_ts = start_vesting_ts + 1).
    startTs: new BN(NOW - 1_001),
    endTs: new BN(NOW - 1_000),
    clawbackStartTs: new BN(NOW + 1_000_000_000),
    clawbackReceiver: Keypair.generate().publicKey,
    admin: Keypair.generate().publicKey,
    clawedBack: false,
    enableSlot: new BN(0),
    closable: false,
    buffer0: Array.from(Buffer.alloc(32)),
    buffer1: Array.from(Buffer.alloc(32)),
    buffer2: Array.from(Buffer.alloc(32)),
  });
  // MerkleDistributor::LEN = 8 + size_of::<MerkleDistributor>() (includes Rust struct
  // padding), larger than the borsh payload; pad so the account matches on-chain sizing.
  const padded = Buffer.alloc(368);
  distributorData.copy(padded);
  svm.setAccount(distributor, {
    lamports: 10_000_000,
    data: padded,
    owner: MD_PROGRAM_ID,
    executable: false,
  });

  setTokenAccount(svm, vault, mint, distributor, allocation);

  // Anchor's Program only builds instructions here (all accounts passed explicitly), so
  // the connection is never used.
  const provider = new AnchorProvider(new Connection('http://127.0.0.1:8899'), new Wallet(payer), {});
  const exampleProgram = new Program<BadDebtExample>(EXAMPLE_IDL, EXAMPLE_PROGRAM_ID, provider);

  return {
    svm,
    payer,
    admin,
    mint,
    distributor,
    vault,
    badDebtAuthority,
    badDebtAta,
    config: deriveConfig(),
    claimStatus: deriveClaimStatus(badDebtAuthority, distributor),
    proof,
    allocation,
    exampleProgram,
  };
}

export function sendTx(
  svm: LiteSVM,
  ixs: TransactionInstruction[],
  payer: Keypair,
  extraSigners: Keypair[] = [],
): TransactionMetadata {
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.add(...ixs);
  tx.sign(payer, ...extraSigners);
  const result = svm.sendTransaction(tx);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`transaction failed: ${result.err().toString()}\n${result.meta().logs().join('\n')}`);
  }
  return result as TransactionMetadata;
}

export function sendTxExpectFail(
  svm: LiteSVM,
  ixs: TransactionInstruction[],
  payer: Keypair,
  extraSigners: Keypair[] = [],
): FailedTransactionMetadata {
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.add(...ixs);
  tx.sign(payer, ...extraSigners);
  const result = svm.sendTransaction(tx);
  if (!(result instanceof FailedTransactionMetadata)) {
    throw new Error(`expected failure but transaction succeeded:\n${(result as TransactionMetadata).logs().join('\n')}`);
  }
  return result;
}

export function tokenBalance(svm: LiteSVM, address: PublicKey): bigint {
  const account = svm.getAccount(address);
  if (!account) return 0n;
  return AccountLayout.decode(Buffer.from(account.data)).amount;
}
