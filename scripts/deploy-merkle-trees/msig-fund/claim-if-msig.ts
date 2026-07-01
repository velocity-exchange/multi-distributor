#!/usr/bin/env tsx
/**
 * claim-if-msig.ts — Claim IF distributor entitlements on behalf of a Squads V4
 * vault (e.g. the protocol IF vault 4JM5… = vault index 1), as ONE multisig
 * proposal.
 *
 * `new_claim` requires the *claimant* to sign, so when the claimant is a Squads
 * vault the claim must run inside a Squads proposal. This reads the claimant's
 * node + merkle proof from the local tree(s), builds `new_claim`, and bundles
 * every claim into a single Squads `Batch` (one approval): batchCreate +
 * proposalCreate(draft) -> one batchAddTransaction per claim (one claim per
 * inner tx, since merkle proofs are large) -> proposalActivate. Members approve
 * once, then execute each inner transaction.
 *
 * `--all` claims every deployed market where the vault is a claimant. Markets in
 * the config's exclude_markets (Token-2022 — no distributor; those go through
 * distribute-t22-msig) and markets the vault isn't in are skipped, as are
 * markets it has already claimed.
 *
 * The claimant vault PAYS the per-claim `claimStatus` rent (~0.0017 SOL) and any
 * missing destination-ATA rent, so it needs some SOL; the script estimates this
 * and warns if the vault looks short.
 *
 * Usage (from this dir, after `npm install`):
 *   # all of the protocol vault's claims in one batch/proposal
 *   npm run claim -- --config ../if-markets.mainnet.json \
 *     --multisig 7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM --vault-index 1 \
 *     --keypair ~/.config/solana/<member>.json --all
 *
 *   # single market:  --market USD1 / --index 62      preview:  --dry-run
 *
 * FUND FIRST: a claim moves tokens out of the distributor vault, so each market
 * must already be funded (and that fund proposal executed) or the claim reverts.
 */
import { AnchorProvider, BN, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
	createAssociatedTokenAccountIdempotentInstruction,
	getAssociatedTokenAddressSync,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	AccountInfo,
	Connection,
	Keypair,
	PublicKey,
	Transaction,
	TransactionInstruction,
	TransactionMessage,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import idlJson from '../../../target/idl/merkle_distributor.json' assert { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Market = { index: number; symbol: string; mint: string; decimals: number };
type IfConfig = { rpc_url?: string; program_id: string; trees_dir?: string; exclude_markets?: number[]; markets: Market[] };
type TreeNode = { claimant: number[]; amount: number; locked_amount: number; proof: number[][] };
type TreeFile = { airdrop_version: number; tree_nodes: TreeNode[] };

const expandHome = (p: string) => (p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p);
const loadKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(expandHome(p), 'utf-8'))));
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
function fmtAmount(raw: bigint, decimals: number): string {
	const s = raw.toString().padStart(decimals + 1, '0');
	const frac = s.slice(s.length - decimals).replace(/0+$/, '');
	return frac ? `${s.slice(0, s.length - decimals)}.${frac}` : s.slice(0, s.length - decimals);
}
function deriveDistributorPda(programId: PublicKey, mint: PublicKey, version: number): PublicKey {
	const v = Buffer.alloc(8);
	v.writeBigUInt64LE(BigInt(version));
	return PublicKey.findProgramAddressSync([Buffer.from('MerkleDistributor'), mint.toBuffer(), v], programId)[0];
}
function deriveClaimStatus(claimant: PublicKey, distributor: PublicKey, programId: PublicKey): PublicKey {
	return PublicKey.findProgramAddressSync([Buffer.from('ClaimStatus'), claimant.toBuffer(), distributor.toBuffer()], programId)[0];
}
// Find the claimant's node (+ tree version) in a market's tree dir, or null.
function findNode(treeDir: string, claimantBytes: Uint8Array): { node: TreeNode; version: number } | null {
	if (!fs.existsSync(treeDir)) return null;
	for (const f of fs.readdirSync(treeDir).filter((f) => f.startsWith('tree_') && f.endsWith('.json'))) {
		const tree = readJson<TreeFile>(path.join(treeDir, f));
		const node = tree.tree_nodes.find((n) => Buffer.from(n.claimant).equals(claimantBytes));
		if (node) return { node, version: tree.airdrop_version };
	}
	return null;
}
async function getMany(connection: Connection, keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
	const out: (AccountInfo<Buffer> | null)[] = [];
	for (let i = 0; i < keys.length; i += 100) out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 100))));
	return out;
}

async function main() {
	const program = new Command();
	program
		.name('claim-if-msig')
		.description('Claim IF entitlements for a Squads vault as ONE multisig batch proposal')
		.requiredOption('-m, --multisig <pubkey>', 'Squads V4 multisig PDA controlling the claimant vault')
		.requiredOption('-k, --keypair <path>', 'proposer keypair (a multisig member; records as creator)')
		.option('-c, --config <path>', 'IF config JSON', path.resolve(__dirname, '..', 'if-markets.mainnet.json'))
		.option('--all', 'claim every deployed market where the vault is a claimant')
		.option('--market <symbol>', 'a single market (e.g. USD1)')
		.option('--index <n>', 'a single market index')
		.option('--vault-index <n>', 'Squads vault index = the claimant', '1')
		.option('-u, --url <rpc>', 'RPC URL override (default: config.rpc_url)')
		.option('--trees-dir <dir>', 'trees dir override (default: config.trees_dir)')
		.option('--dry-run', 'plan + print without submitting', false)
		.parse(process.argv);
	const opts = program.opts();
	if (!opts.all && !opts.market && opts.index == null) throw new Error('select scope: --all, --market <symbol>, or --index <n>');

	const configPath = path.resolve(expandHome(opts.config));
	const base = path.dirname(configPath);
	const config = readJson<IfConfig>(configPath);
	const programId = new PublicKey(config.program_id);
	const rpcUrl = opts.url ?? config.rpc_url;
	if (!rpcUrl) throw new Error('no RPC url (pass --url or set rpc_url in config)');
	const treesDir = opts.treesDir ? path.resolve(expandHome(opts.treesDir)) : path.resolve(base, config.trees_dir ?? './if-trees');
	const excluded = new Set<number>((config.exclude_markets ?? []) as number[]);

	// Scope → candidate markets.
	let candidates: Market[];
	if (opts.all) {
		candidates = config.markets.filter((m) => !excluded.has(m.index));
	} else {
		const m = config.markets.find((mk) =>
			opts.market ? mk.symbol.toLowerCase() === String(opts.market).toLowerCase() : mk.index === Number(opts.index)
		);
		if (!m) throw new Error(`market ${opts.market ?? `index ${opts.index}`} not in config`);
		if (excluded.has(m.index)) throw new Error(`${m.index}-${m.symbol} is excluded (Token-2022 — use distribute-t22-msig)`);
		candidates = [m];
	}

	const connection = new Connection(rpcUrl, 'confirmed');
	const wallet = new Wallet(loadKeypair(opts.keypair));
	const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
	const dist = new Program(idlJson as Idl, programId, provider);

	const multisigPda = new PublicKey(opts.multisig);
	const vaultIndex = Number(opts.vaultIndex);
	const [claimant] = multisig.getVaultPda({ multisigPda, index: vaultIndex });
	const claimantBytes = claimant.toBytes();

	console.log(`==> IF multisig claim`);
	console.log(`    rpc        ${rpcUrl}`);
	console.log(`    multisig   ${multisigPda.toBase58()}`);
	console.log(`    claimant   ${claimant.toBase58()}  (vault ${vaultIndex})`);
	console.log(`    proposer   ${wallet.publicKey.toBase58()}`);
	console.log(`    scope      ${opts.all ? 'all deployed markets' : candidates[0].index + '-' + candidates[0].symbol}`);
	console.log(`    dry-run    ${!!opts.dryRun}`);
	console.log();

	// Resolve each candidate to a tree node; drop markets the vault isn't in.
	type Hit = { market: Market; node: TreeNode; version: number; distributor: PublicKey; from: PublicKey; to: PublicKey; claimStatus: PublicKey };
	const hits: Hit[] = [];
	for (const market of candidates) {
		const found = findNode(path.join(treesDir, `${market.index}-${market.symbol}`), claimantBytes);
		if (!found) {
			if (!opts.all) throw new Error(`claimant ${claimant.toBase58()} is not in the ${market.index}-${market.symbol} tree`);
			continue;
		}
		const mint = new PublicKey(market.mint);
		const distributor = deriveDistributorPda(programId, mint, found.version);
		hits.push({
			market, node: found.node, version: found.version, distributor,
			from: getAssociatedTokenAddressSync(mint, distributor, true, TOKEN_PROGRAM_ID),
			to: getAssociatedTokenAddressSync(mint, claimant, true, TOKEN_PROGRAM_ID),
			claimStatus: deriveClaimStatus(claimant, distributor, programId),
		});
	}
	if (hits.length === 0) throw new Error(`${claimant.toBase58()} is not a claimant in any in-scope market`);

	// Batch existence checks: distributor deployed? already claimed? dest ATA?
	const distInfos = await getMany(connection, hits.map((h) => h.distributor));
	const csInfos = await getMany(connection, hits.map((h) => h.claimStatus));
	const ataInfos = await getMany(connection, hits.map((h) => h.to));

	const claims: { label: string; amount: bigint; ixs: TransactionInstruction[] }[] = [];
	let skippedClaimed = 0, skippedUndeployed = 0, atasToCreate = 0;
	for (let i = 0; i < hits.length; i++) {
		const h = hits[i];
		const label = `${h.market.index}-${h.market.symbol}`;
		const amount = BigInt(h.node.amount) + BigInt(h.node.locked_amount);
		if (!distInfos[i]) { console.log(`    [${label}] skip: distributor not deployed`); skippedUndeployed++; continue; }
		if (csInfos[i]) { console.log(`    [${label}] skip: already claimed`); skippedClaimed++; continue; }

		const mint = new PublicKey(h.market.mint);
		const ixs: TransactionInstruction[] = [];
		if (!ataInfos[i]) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(claimant, h.to, claimant, mint, TOKEN_PROGRAM_ID)); atasToCreate++; }
		const claimIx = await dist.methods
			.newClaim(new BN(h.node.amount.toString()), new BN(h.node.locked_amount.toString()), h.node.proof.map((p) => Buffer.from(p)))
			.accountsStrict({ distributor: h.distributor, claimStatus: h.claimStatus, from: h.from, to: h.to, claimant, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: PublicKey.default })
			.instruction();
		ixs.push(claimIx);
		claims.push({ label, amount, ixs });
		console.log(`    [${label}] claim ${fmtAmount(amount, h.market.decimals)} ${h.market.symbol} (v${h.version})`);
	}
	console.log();

	if (claims.length === 0) {
		console.log(`==> Nothing to claim (${skippedClaimed} already claimed, ${skippedUndeployed} not deployed).`);
		return;
	}

	// SOL preflight: the claimant vault pays claimStatus rent + any new-ATA rent.
	const csRent = await connection.getMinimumBalanceForRentExemption(130); // ~ClaimStatus::LEN
	const ataRent = await connection.getMinimumBalanceForRentExemption(165); // token account
	const needLamports = claims.length * csRent + atasToCreate * ataRent;
	const haveLamports = (await connection.getAccountInfo(claimant))?.lamports ?? 0;
	console.log(`==> ONE batch: ${claims.length} claim(s) (${skippedClaimed} already claimed, ${skippedUndeployed} not deployed, ${atasToCreate} ATA(s) to create)`);
	console.log(`    vault SOL for rent: need ~${(needLamports / 1e9).toFixed(4)}, have ${(haveLamports / 1e9).toFixed(4)}` + (haveLamports < needLamports ? '  ⚠️ TOP UP THE VAULT' : ''));
	console.log();

	if (opts.dryRun) {
		console.log(`    [dry-run] would batchCreate + proposalCreate(draft) + ${claims.length}x batchAddTransaction + proposalActivate`);
		console.log(`    (dry-run — nothing submitted)`);
		return;
	}

	const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
	const batchIndex = BigInt(ms.transactionIndex.toString()) + 1n;

	// 1. batch + draft proposal.
	let sig = await provider.sendAndConfirm(new Transaction().add(
		multisig.instructions.batchCreate({ multisigPda, creator: wallet.publicKey, batchIndex, vaultIndex, memo: `IF claims for vault ${vaultIndex} (${claims.length})` }),
		multisig.instructions.proposalCreate({ multisigPda, transactionIndex: batchIndex, creator: wallet.publicKey, isDraft: true }),
	));
	console.log(`==> batchCreate + proposalCreate(draft) batchIndex=${batchIndex} sig=${sig}`);

	// 2. one claim per inner transaction (proofs are large).
	for (let i = 0; i < claims.length; i++) {
		const { blockhash } = await connection.getLatestBlockhash();
		const message = new TransactionMessage({ payerKey: claimant, recentBlockhash: blockhash, instructions: claims[i].ixs });
		sig = await provider.sendAndConfirm(new Transaction().add(multisig.instructions.batchAddTransaction({
			vaultIndex, multisigPda, member: wallet.publicKey, batchIndex, transactionIndex: i + 1, ephemeralSigners: 0, transactionMessage: message,
		})));
		console.log(`    + inner ${i + 1}/${claims.length} (${claims[i].label}) sig=${sig}`);
	}

	// 3. activate for voting.
	sig = await provider.sendAndConfirm(new Transaction().add(multisig.instructions.proposalActivate({ multisigPda, transactionIndex: batchIndex, member: wallet.publicKey })));
	console.log(`==> proposalActivate sig=${sig}`);
	console.log();
	console.log(`==> Done. ONE proposal (batchIndex ${batchIndex}) with ${claims.length} claim(s).`);
	console.log(`    Members approve once, then execute each inner transaction (batchExecuteTransaction). Each market must already be funded.`);
}

main().catch((e) => {
	console.error(`\nERROR: ${e.message ?? e}`);
	process.exit(1);
});
