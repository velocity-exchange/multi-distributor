// Runs the built program (target/deploy/merkle_distributor.so) in LiteSVM.
// Build first: cargo-build-sbf --tools-version v1.37 --manifest-path programs/merkle-distributor/Cargo.toml
import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const PROGRAM_ID = new PublicKey("distAitdwx9mDm3SaPMtGZRjpXMPUenLhmPwoySV3Hp");
const DFX_MINT = new PublicKey("dfxQsZjikuu5DGXPgX7yEpRog74HT5cJgytT3i5iLtw");
const SO_PATH = new URL("../../target/deploy/merkle_distributor.so", import.meta.url).pathname;
const U64_MAX = 2n ** 64n - 1n;
const DISTRIBUTOR_LEN = 352; // MerkleDistributor::LEN = 8 + size_of::<MerkleDistributor>()

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
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
const disc = (ix: string) => sha256(Buffer.from(`global:${ix}`)).subarray(0, 8);
const cmp = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Same hashing as jito_merkle_verify: leaf = H(0 || H(claimant || unlocked || locked)), node = H(1 || sorted pair).
type Leaf = { claimant: PublicKey; amount: bigint };
function buildTree(leaves: Leaf[]) {
  const hashed = leaves.map((l) =>
    sha256(Uint8Array.of(0), sha256(l.claimant.toBytes(), u64(l.amount), u64(0n))),
  );
  const proofs = hashed.map(() => [] as Uint8Array[]);
  let level = hashed.map((h, i) => ({ h, members: [i] }));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1];
      if (!b) {
        next.push(a);
        continue;
      }
      for (const m of a.members) proofs[m].push(b.h);
      for (const m of b.members) proofs[m].push(a.h);
      const [lo, hi] = cmp(a.h, b.h) <= 0 ? [a.h, b.h] : [b.h, a.h];
      next.push({ h: sha256(Uint8Array.of(1), lo, hi), members: [...a.members, ...b.members] });
    }
    level = next;
  }
  return { root: level[0].h, proofs };
}

function distributorData(o: {
  bump: number;
  root: Uint8Array;
  mint: PublicKey;
  vault: PublicKey;
  maxTotalClaim: bigint;
  maxNumNodes: bigint;
  admin: PublicKey;
}) {
  const body = Buffer.concat([
    sha256(Buffer.from("account:MerkleDistributor")).subarray(0, 8),
    Uint8Array.of(o.bump),
    u64(0n), // version
    o.root,
    o.mint.toBytes(),
    o.vault.toBytes(),
    u64(o.maxTotalClaim),
    u64(o.maxNumNodes),
    u64(0n), // total_amount_claimed
    u64(0n), // total_amount_forgone
    u64(0n), // num_nodes_claimed
    i64(0n), // start_ts
    i64(1n), // end_ts
    i64(2_000_000_000n), // clawback_start_ts
    o.admin.toBytes(), // clawback_receiver (unused here)
    o.admin.toBytes(),
    Uint8Array.of(0), // clawed_back
    u64(0n), // enable_slot
    Uint8Array.of(0), // closable
    Buffer.alloc(96),
  ]);
  return Buffer.concat([body, Buffer.alloc(DISTRIBUTOR_LEN - body.length)]);
}

describe("set_root", () => {
  let svm: LiteSVM;
  let admin: Keypair;
  let users: Keypair[];
  let distributor: PublicKey;
  let vault: PublicKey;
  let oldLeaves: Leaf[];
  let oldTree: ReturnType<typeof buildTree>;
  const OLD = [1_000_000n, 5_000_000n, 3_000_000n];
  const MAX = OLD.reduce((a, b) => a + b);

  const send = (ixs: TransactionInstruction[], signers: Keypair[]) => {
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    const res = svm.sendTransaction(tx);
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

  const tokenAmount = (addr: PublicKey) =>
    AccountLayout.decode(Buffer.from(svm.getAccount(addr)!.data)).amount;
  const supply = () => MintLayout.decode(Buffer.from(svm.getAccount(DFX_MINT)!.data)).supply;

  const setTokenAccount = (addr: PublicKey, owner: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint: DFX_MINT,
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
    svm.setAccount(addr, { lamports: 2_039_280, data, owner: TOKEN_PROGRAM_ID, executable: false });
  };
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(DFX_MINT, owner, true);

  const setEnableSlotIx = (slot: bigint, signer = admin.publicKey) =>
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: distributor, isSigner: false, isWritable: true },
        { pubkey: signer, isSigner: true, isWritable: true },
      ],
      data: Buffer.concat([disc("set_enable_slot"), u64(slot)]),
    });
  const setRootIx = (
    newRoot: Uint8Array,
    expectedOldRoot: Uint8Array,
    newMax: bigint,
    signer = admin.publicKey,
    target = { distributor, vault, mint: DFX_MINT },
  ) =>
    new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: target.distributor, isSigner: false, isWritable: true },
        { pubkey: target.vault, isSigner: false, isWritable: true },
        { pubkey: target.mint, isSigner: false, isWritable: true },
        { pubkey: signer, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("set_root"), newRoot, expectedOldRoot, u64(newMax)]),
    });
  const claimIx = (user: Keypair, amount: bigint, proof: Uint8Array[]) => {
    const [claimStatus] = PublicKey.findProgramAddressSync(
      [Buffer.from("ClaimStatus"), user.publicKey.toBytes(), distributor.toBytes()],
      PROGRAM_ID,
    );
    const len = Buffer.alloc(4);
    len.writeUInt32LE(proof.length);
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: distributor, isSigner: false, isWritable: true },
        { pubkey: claimStatus, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: ata(user.publicKey), isSigner: false, isWritable: true },
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("new_claim"), u64(amount), u64(0n), len, ...proof]),
    });
  };

  beforeEach(() => {
    svm = new LiteSVM();
    svm.addProgramFromFile(PROGRAM_ID, SO_PATH);
    admin = Keypair.generate();
    users = [0, 1, 2].map(() => Keypair.generate());
    for (const k of [admin, ...users]) svm.airdrop(k.publicKey, 10_000_000_000n);

    const [pda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("MerkleDistributor"), DFX_MINT.toBytes(), u64(0n)],
      PROGRAM_ID,
    );
    distributor = pda;
    vault = ata(distributor);

    const mintData = Buffer.alloc(MINT_SIZE);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: MAX + 1_000n,
        decimals: 6,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      mintData,
    );
    svm.setAccount(DFX_MINT, { lamports: 1_461_600, data: mintData, owner: TOKEN_PROGRAM_ID, executable: false });
    setTokenAccount(vault, distributor, MAX);
    setTokenAccount(ata(admin.publicKey), admin.publicKey, 1_000n);
    for (const u of users) setTokenAccount(ata(u.publicKey), u.publicKey, 0n);

    oldLeaves = users.map((u, i) => ({ claimant: u.publicKey, amount: OLD[i] }));
    oldTree = buildTree(oldLeaves);
    svm.setAccount(distributor, {
      lamports: 10_000_000,
      data: distributorData({
        bump,
        root: oldTree.root,
        mint: DFX_MINT,
        vault,
        maxTotalClaim: MAX,
        maxNumNodes: 3n,
        admin: admin.publicKey,
      }),
      owner: PROGRAM_ID,
      executable: false,
    });
    // Past end_ts, so claims are fully unlocked (as on mainnet).
    const clock = svm.getClock();
    clock.slot = 100n;
    clock.unixTimestamp = 1_800_000_000n;
    svm.setClock(clock);
  });

  test("re-roots a paused shard, burns the decrease, and every new leaf is claimable", () => {
    // User 0 claims before the pause and keeps that claim.
    expectOk(send([claimIx(users[0], OLD[0], oldTree.proofs[0])], [users[0]]));

    const cut = 4_000_000n; // user 1: 5.0 -> 1.0
    const newLeaves = oldLeaves.map((l, i) => (i === 1 ? { ...l, amount: l.amount - cut } : l));
    const newTree = buildTree(newLeaves);
    const newMax = MAX - cut;

    expectErr(send([setRootIx(newTree.root, oldTree.root, newMax)], [admin]), "DistributorNotPaused");
    expectOk(send([setEnableSlotIx(U64_MAX)], [admin]));
    expectErr(send([claimIx(users[1], OLD[1], oldTree.proofs[1])], [users[1]]), "ClaimingIsNotStarted");

    const outsider = Keypair.generate();
    svm.airdrop(outsider.publicKey, 1_000_000_000n);
    expectErr(send([setRootIx(newTree.root, oldTree.root, newMax, outsider.publicKey)], [outsider]), "Unauthorized");
    expectErr(send([setRootIx(newTree.root, newTree.root, newMax)], [admin]), "RootMismatch");
    expectErr(send([setRootIx(newTree.root, oldTree.root, MAX + 1n)], [admin]), "MaxTotalClaimIncrease");

    // A donation into the vault must not block or change the burn.
    const donation = Buffer.alloc(9);
    donation[0] = 3; // spl-token Transfer
    donation.writeBigUInt64LE(7n, 1);
    expectOk(
      send(
        [
          new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [
              { pubkey: ata(admin.publicKey), isSigner: false, isWritable: true },
              { pubkey: vault, isSigner: false, isWritable: true },
              { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            ],
            data: donation,
          }),
        ],
        [admin],
      ),
    );

    const supplyBefore = supply();
    const vaultBefore = tokenAmount(vault);
    expectOk(send([setRootIx(newTree.root, oldTree.root, newMax)], [admin]));
    expect(supply()).toBe(supplyBefore - cut);
    expect(tokenAmount(vault)).toBe(vaultBefore - cut);

    expectOk(send([setEnableSlotIx(0n)], [admin]));
    expectErr(send([claimIx(users[0], OLD[0], newTree.proofs[0])], [users[0]]), "already in use");
    expectErr(send([claimIx(users[1], OLD[1], oldTree.proofs[1])], [users[1]]), "InvalidProof");
    expectOk(send([claimIx(users[1], newLeaves[1].amount, newTree.proofs[1])], [users[1]]));
    expectOk(send([claimIx(users[2], newLeaves[2].amount, newTree.proofs[2])], [users[2]]));

    expect(tokenAmount(ata(users[0].publicKey))).toBe(OLD[0]);
    expect(tokenAmount(ata(users[1].publicKey))).toBe(OLD[1] - cut);
    expect(tokenAmount(ata(users[2].publicKey))).toBe(OLD[2]);
    expect(tokenAmount(vault)).toBe(7n); // only the donation is left
  });

  test("rejects a non-DFX distributor", () => {
    const mint = Keypair.generate().publicKey;
    const [other, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("MerkleDistributor"), mint.toBytes(), u64(0n)],
      PROGRAM_ID,
    );
    const otherVault = getAssociatedTokenAddressSync(mint, other, true);
    svm.setAccount(mint, { ...svm.getAccount(DFX_MINT)!, data: svm.getAccount(DFX_MINT)!.data });
    const vaultData = Buffer.from(svm.getAccount(vault)!.data);
    mint.toBuffer().copy(vaultData, 0);
    other.toBuffer().copy(vaultData, 32);
    svm.setAccount(otherVault, { ...svm.getAccount(vault)!, data: vaultData });
    const data = distributorData({
      bump,
      root: oldTree.root,
      mint,
      vault: otherVault,
      maxTotalClaim: MAX,
      maxNumNodes: 3n,
      admin: admin.publicKey,
    });
    data.writeBigUInt64LE(U64_MAX, 8 + 1 + 8 + 32 * 3 + 8 * 5 + 8 * 3 + 32 * 2 + 1); // enable_slot: paused
    svm.setAccount(other, { lamports: 10_000_000, data, owner: PROGRAM_ID, executable: false });

    const res = send([setRootIx(oldTree.root, oldTree.root, MAX - 1n, admin.publicKey, { distributor: other, vault: otherVault, mint })], [admin]);
    expectErr(res, "MintNotReRootable");
  });
});
