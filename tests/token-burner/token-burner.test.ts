// Runs the built programs (target/deploy/{merkle_distributor,token_burner}.so) in LiteSVM.
// Build first:
//   cargo build-sbf --arch v3 --tools-version v1.57 --manifest-path programs/merkle-distributor/Cargo.toml
//   cargo build-sbf --arch v3 --tools-version v1.57 --manifest-path programs/token-burner/Cargo.toml
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { address, getTransactionDecoder, lamports } from "@solana/kit";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const DISTRIBUTOR_ID = new PublicKey("distAitdwx9mDm3SaPMtGZRjpXMPUenLhmPwoySV3Hp");
const BURNER_ID = new PublicKey("burnhrRSRkbYBPbVWCVwMUxJMmVPtQqHBCUAVzkJ5tW");
const DFX_MINT = new PublicKey("dfxQsZjikuu5DGXPgX7yEpRog74HT5cJgytT3i5iLtw");
const DEPLOY_DIR = new URL("../../target/deploy/", import.meta.url).pathname;
const DISTRIBUTOR_LEN = 352; // MerkleDistributor::LEN = 8 + size_of::<MerkleDistributor>()
const CLAWED_BACK_OFFSET = 241;
const CLAWBACK_START = 1_830_297_600n;
const SUPPLY = 1_000_000_000n;
const VAULT = 600_000_000n;

const [BURNER] = PublicKey.findProgramAddressSync([Buffer.from("burner")], BURNER_ID);

// LiteSVM takes @solana/kit types. The test builds with web3.js and converts here.
const kit = (pk: PublicKey) => address(pk.toBase58());

const sha256 = (s: string) => createHash("sha256").update(s).digest();
const disc = (ix: string) => sha256(`global:${ix}`).subarray(0, 8);
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const i64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
};

function distributorData(o: { bump: number; vault: PublicKey; clawbackReceiver: PublicKey; admin: PublicKey }) {
  const body = Buffer.concat([
    sha256("account:MerkleDistributor").subarray(0, 8),
    Uint8Array.of(o.bump),
    u64(0n), // version
    Buffer.alloc(32), // root
    DFX_MINT.toBytes(),
    o.vault.toBytes(),
    u64(VAULT), // max_total_claim
    u64(1n), // max_num_nodes
    u64(0n), // total_amount_claimed
    u64(0n), // total_amount_forgone
    u64(0n), // num_nodes_claimed
    i64(0n), // start_ts
    i64(1n), // end_ts
    i64(CLAWBACK_START),
    o.clawbackReceiver.toBytes(),
    o.admin.toBytes(),
    Uint8Array.of(0), // clawed_back
    u64(0n), // enable_slot
    Uint8Array.of(0), // closable
    Buffer.alloc(96),
  ]);
  return Buffer.concat([body, Buffer.alloc(DISTRIBUTOR_LEN - body.length)]);
}

describe("token_burner", () => {
  let svm: LiteSVM;
  let cranker: Keypair;
  let distributor: PublicKey;
  let vault: PublicKey;
  let burnerAta: PublicKey;

  const send = (ixs: TransactionInstruction[], signer = cranker) => {
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = signer.publicKey;
    tx.sign(signer);
    const res = svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
    svm.expireBlockhash();
    return res;
  };
  const logsOf = (res: ReturnType<LiteSVM["sendTransaction"]>) =>
    (res instanceof FailedTransactionMetadata ? res.meta() : res).logs().join("\n");
  const expectOk = (res: ReturnType<LiteSVM["sendTransaction"]>) => {
    if (res instanceof FailedTransactionMetadata) throw new Error(logsOf(res));
  };
  const expectErr = (res: ReturnType<LiteSVM["sendTransaction"]>, needle: string) => {
    expect(res).toBeInstanceOf(FailedTransactionMetadata);
    expect(logsOf(res)).toContain(needle);
  };

  const dataOf = (addr: PublicKey) => {
    const account = svm.getAccount(kit(addr));
    if (!account.exists) throw new Error(`missing account ${addr}`);
    return Buffer.from(account.data);
  };
  const setAccount = (addr: PublicKey, owner: PublicKey, data: Buffer, balance: bigint) =>
    svm.setAccount({
      address: kit(addr),
      data,
      executable: false,
      lamports: lamports(balance),
      programAddress: kit(owner),
      space: BigInt(data.length),
    });
  const tokenAmount = (addr: PublicKey) => AccountLayout.decode(dataOf(addr)).amount;
  const supply = (mint = DFX_MINT) => MintLayout.decode(dataOf(mint)).supply;
  const clawedBack = () => dataOf(distributor)[CLAWED_BACK_OFFSET];
  const setTime = (unixTimestamp: bigint) => {
    const clock = svm.getClock();
    clock.unixTimestamp = unixTimestamp;
    svm.setClock(clock);
  };

  const setMint = (mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) => {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: SUPPLY,
        decimals: 6,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      data,
    );
    setAccount(mint, tokenProgram, data, 1_461_600n);
  };
  const setTokenAccount = (
    addr: PublicKey,
    owner: PublicKey,
    amount: bigint,
    mint = DFX_MINT,
    tokenProgram = TOKEN_PROGRAM_ID,
  ) => {
    const data = Buffer.alloc(ACCOUNT_SIZE);
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
    setAccount(addr, tokenProgram, data, 2_039_280n);
  };

  const clawbackIx = () =>
    new TransactionInstruction({
      programId: DISTRIBUTOR_ID,
      keys: [
        { pubkey: distributor, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: burnerAta, isSigner: false, isWritable: true },
        { pubkey: cranker.publicKey, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(disc("clawback")),
    });
  const burnIx = (tokenAccount = burnerAta, mint = DFX_MINT, tokenProgram = TOKEN_PROGRAM_ID) =>
    new TransactionInstruction({
      programId: BURNER_ID,
      keys: [
        { pubkey: BURNER, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: tokenAccount, isSigner: false, isWritable: true },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(disc("burn")),
    });

  beforeEach(() => {
    svm = new LiteSVM();
    svm.addProgramFromFile(kit(DISTRIBUTOR_ID), `${DEPLOY_DIR}merkle_distributor.so`);
    svm.addProgramFromFile(kit(BURNER_ID), `${DEPLOY_DIR}token_burner.so`);
    cranker = Keypair.generate();
    svm.airdrop(kit(cranker.publicKey), lamports(10_000_000_000n));

    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("MerkleDistributor"), DFX_MINT.toBytes(), u64(0n)],
      DISTRIBUTOR_ID,
    );
    distributor = pda;
    vault = getAssociatedTokenAddressSync(DFX_MINT, distributor, true);
    burnerAta = getAssociatedTokenAddressSync(DFX_MINT, BURNER, true);

    setMint(DFX_MINT);
    setTokenAccount(vault, distributor, VAULT);
    setTokenAccount(burnerAta, BURNER, 0n);
    setAccount(
      distributor,
      DISTRIBUTOR_ID,
      distributorData({ bump, vault, clawbackReceiver: burnerAta, admin: Keypair.generate().publicKey }),
      10_000_000n,
    );
    setTime(CLAWBACK_START - 1n);
  });

  test("anyone claws back and burns in one transaction once clawback starts", () => {
    expectErr(send([clawbackIx(), burnIx()]), "ClawbackBeforeStart");

    setTime(CLAWBACK_START);
    const res = send([clawbackIx(), burnIx()]);
    expectOk(res);
    expect(logsOf(res)).toContain("Program data: "); // BurnEvent

    expect(tokenAmount(vault)).toBe(0n);
    expect(tokenAmount(burnerAta)).toBe(0n);
    expect(supply()).toBe(SUPPLY - VAULT);
    expect(clawedBack()).toBe(1);

    expectErr(send([clawbackIx()]), "ClawbackAlreadyClaimed");
  });

  test("burns tokens sent to the burner from anywhere", () => {
    setTokenAccount(burnerAta, BURNER, 42n);
    expectOk(send([burnIx()]));
    expect(tokenAmount(burnerAta)).toBe(0n);
    expect(supply()).toBe(SUPPLY - 42n);
  });

  test("an empty balance succeeds and burns nothing", () => {
    expectOk(send([burnIx()]));
    expect(supply()).toBe(SUPPLY);
  });

  test("rejects a token account the burner does not own", () => {
    const other = Keypair.generate().publicKey;
    const otherAta = getAssociatedTokenAddressSync(DFX_MINT, other);
    setTokenAccount(otherAta, other, 5n);
    expectErr(send([burnIx(otherAta)]), "ConstraintTokenOwner");
    expect(tokenAmount(otherAta)).toBe(5n);
  });

  test("rejects a mint that is not the token account's mint", () => {
    const otherMint = Keypair.generate().publicKey;
    setMint(otherMint);
    setTokenAccount(burnerAta, BURNER, 5n);
    expectErr(send([burnIx(burnerAta, otherMint)]), "ConstraintTokenMint");
    expect(tokenAmount(burnerAta)).toBe(5n);
  });

  test("burns a Token-2022 balance", () => {
    const mint = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(mint, BURNER, true, TOKEN_2022_PROGRAM_ID);
    setMint(mint, TOKEN_2022_PROGRAM_ID);
    setTokenAccount(ata, BURNER, 7n, mint, TOKEN_2022_PROGRAM_ID);
    expectOk(send([burnIx(ata, mint, TOKEN_2022_PROGRAM_ID)]));
    expect(tokenAmount(ata)).toBe(0n);
    expect(supply(mint)).toBe(SUPPLY - 7n);
  });
});
