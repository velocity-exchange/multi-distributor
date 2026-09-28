#!/usr/bin/env tsx
/**
 * distribute-t22-msig.ts — Directly distribute the Token-2022 IF markets to
 * their holders from the Squads V4 vault, instead of going through a merkle
 * distributor.
 *
 * The merkle-distributor program is classic-SPL-Token only (it uses
 * `Program<Token>` / `token::TokenAccount`), so the Token-2022 IF mints
 * (PYUSD, AUSD, CASH, AI16Z, PUMP) can't be deployed as distributors without a
 * program change. Holder counts are tiny (≤40 each, 77 total), so the simplest
 * safe path is to pay each holder their CSV `amount` directly with a Token-2022
 * `transfer_checked` from the vault, wrapped in Squads proposals.
 *
 * Two phases (run create-atas first, then propose):
 *
 *   1. --create-atas  (signed by --keypair, NOT the multisig)
 *      Idempotently create each holder's Token-2022 associated token account.
 *      transfer_checked requires the destination ATA to exist; creating them
 *      up front (a) is permissionless and cheap, (b) keeps the multisig
 *      proposals transfer-only so they pack densely, and (c) avoids the vault
 *      needing SOL for rent. Re-running is a no-op for ATAs that already exist.
 *
 *   2. (default)       build ONE Squads Batch (single proposal/approval)
 *      For each holder: transfer_checked(vaultAta -> holderAta, authority=vault,
 *      amount = CSV amount + locked_amount, decimals). All transfers go into a
 *      single Squads `Batch` under one proposal: batchCreate + proposalCreate
 *      (draft) -> one batchAddTransaction per inner chunk (≤ --batch-size
 *      transfers, single-mint, so each inner tx fits the 1232-byte execute
 *      limit) -> proposalActivate. Members approve ONCE, then execute each inner
 *      transaction. Refuses to build if any destination ATA is missing (run
 *      --create-atas first).
 *
 * The CSV `pubkey` is the holder's wallet (owner); the destination is its
 * Token-2022 ATA. locked_amount is 0 for every IF row, so each holder simply
 * receives `amount`.
 *
 * Usage (from this dir, after `npm install`):
 *   # 1. create destination ATAs (deployer pays rent)
 *   npm run distribute-t22 -- --config ../if-markets.mainnet.json \
 *     --keypair ~/.config/solana/id.json --market PYUSD --create-atas
 *
 *   # 2. propose the transfers to the multisig (vault index 1 = 4JM5…)
 *   npm run distribute-t22 -- --config ../if-markets.mainnet.json \
 *     --multisig 7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM --vault-index 1 \
 *     --keypair ~/.config/solana/proposer.json --market PYUSD
 *
 *   # all five Token-2022 markets:                       --all-t22
 *   # preview without sending / submitting:              --dry-run
 */
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import {
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
	getAssociatedTokenAddressSync,
	TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The Token-2022 IF markets, by symbol. Only these can be distributed by this
// script; it refuses anything not in this set (a classic-token mint should go
// through the merkle distributor instead).
const T22_SYMBOLS = ['PYUSD', 'AUSD', 'CASH', 'AI16Z', 'PUMP'];

type Market = { index: number; symbol: string; mint: string; decimals: number };
type IfConfig = { rpc_url?: string; csv_dir?: string; markets: Market[] };
type Holder = { owner: PublicKey; amount: bigint };

function expandHome(p: string): string {
	return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}
function loadKeypair(p: string): Keypair {
	return Keypair.fromSecretKey(
		Uint8Array.from(JSON.parse(fs.readFileSync(expandHome(p), 'utf-8')))
	);
}
function readJson<T>(p: string): T {
	return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}
function fmtAmount(raw: bigint, decimals: number): string {
	const s = raw.toString().padStart(decimals + 1, '0');
	const frac = s.slice(s.length - decimals).replace(/0+$/, '');
	const whole = s.slice(0, s.length - decimals);
	return frac ? `${whole}.${frac}` : whole;
}

// Parse a processed IF CSV: header `pubkey,amount,locked_amount`. Each holder
// receives amount + locked_amount (locked is 0 for IF, summed for safety).
function readHolders(csvPath: string): Holder[] {
	const lines = fs.readFileSync(csvPath, 'utf-8').split('\n');
	const holders: Holder[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		const [pubkey, amount, locked] = line.split(',');
		const total = BigInt(amount) + BigInt(locked ?? '0');
		if (total === 0n) continue;
		holders.push({ owner: new PublicKey(pubkey), amount: total });
	}
	return holders;
}

function chunk<T>(arr: T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

async function main() {
	const program = new Command();
	program
		.name('distribute-t22-msig')
		.description('Directly distribute Token-2022 IF markets to holders via Squads')
		.requiredOption('-k, --keypair <path>', 'signer keypair: pays ATA rent (phase 1) and is recorded as proposal creator (phase 2); for phase 2 must be a multisig member')
		.option('-c, --config <path>', 'IF config JSON', path.resolve(__dirname, '..', 'if-markets.mainnet.json'))
		.option('--market <symbol>', 'a single Token-2022 market (e.g. PYUSD)')
		.option('--all-t22', `all Token-2022 markets (${T22_SYMBOLS.join(', ')})`)
		.option('--create-atas', 'phase 1: create missing destination ATAs (deployer-signed, not multisig)')
		.option('-m, --multisig <pubkey>', 'Squads V4 multisig PDA (phase 2)')
		.option('--vault-index <n>', 'Squads vault index holding the tokens', '1')
		.option('--batch-size <n>', 'transfers per inner batch-transaction (≤15 fits one execute tx)', '10')
		.option('--ata-batch-size <n>', 'ATA creations per tx (phase 1)', '12')
		.option('-u, --url <rpc>', 'RPC URL override (default: config.rpc_url)')
		.option('--dry-run', 'plan + print without sending/submitting', false)
		.parse(process.argv);
	const opts = program.opts();

	if (!opts.allT22 && !opts.market) throw new Error('select scope: --market <symbol> or --all-t22');

	const configPath = path.resolve(expandHome(opts.config));
	const config = readJson<IfConfig>(configPath);
	const csvDir = path.resolve(path.dirname(configPath), config.csv_dir ?? './if-csv', 'processed');
	const rpcUrl = opts.url ?? config.rpc_url;
	if (!rpcUrl) throw new Error('no RPC url (pass --url or set rpc_url in config)');

	// Resolve target markets, validating they're Token-2022.
	let markets = config.markets.filter((m) => T22_SYMBOLS.includes(m.symbol));
	if (!opts.allT22) {
		const want = String(opts.market).toLowerCase();
		const all = config.markets.find((m) => m.symbol.toLowerCase() === want);
		if (!all) throw new Error(`market ${opts.market} not in config`);
		if (!T22_SYMBOLS.includes(all.symbol))
			throw new Error(`${all.symbol} is not a Token-2022 market; use the merkle distributor flow`);
		markets = [all];
	}

	const connection = new Connection(rpcUrl, 'confirmed');
	const wallet = new Wallet(loadKeypair(opts.keypair));
	const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

	console.log(`==> Token-2022 direct distribution`);
	console.log(`    rpc       ${rpcUrl}`);
	console.log(`    signer    ${wallet.publicKey.toBase58()}`);
	console.log(`    markets   ${markets.map((m) => m.symbol).join(', ')}`);
	console.log(`    mode      ${opts.createAtas ? 'create-atas (phase 1)' : 'propose transfers (phase 2)'}`);
	console.log(`    dry-run   ${!!opts.dryRun}`);
	console.log();

	// Build the full per-market holder + ATA plan (shared by both phases).
	type Plan = { market: Market; vaultAta: PublicKey; holders: (Holder & { ata: PublicKey })[] };
	const vaultPda = opts.multisig
		? multisig.getVaultPda({ multisigPda: new PublicKey(opts.multisig), index: Number(opts.vaultIndex) })[0]
		: null;

	const plans: Plan[] = markets.map((m) => {
		const mint = new PublicKey(m.mint);
		const csv = path.join(csvDir, `${m.index}-${m.symbol}.csv`);
		const holders = readHolders(csv).map((h) => ({
			...h,
			ata: getAssociatedTokenAddressSync(mint, h.owner, true, TOKEN_2022_PROGRAM_ID),
		}));
		const vaultAta = vaultPda
			? getAssociatedTokenAddressSync(mint, vaultPda, true, TOKEN_2022_PROGRAM_ID)
			: PublicKey.default;
		return { market: m, vaultAta, holders };
	});

	if (opts.createAtas) {
		await runCreateAtas(provider, plans, opts);
	} else {
		if (!opts.multisig) throw new Error('phase 2 needs --multisig <pubkey>');
		await runPropose(provider, plans, new PublicKey(opts.multisig), vaultPda!, Number(opts.vaultIndex), opts);
	}
}

// ---- Phase 1: create destination ATAs (deployer-signed) --------------------
async function runCreateAtas(provider: AnchorProvider, plans: any[], opts: any) {
	const { connection, wallet } = provider;
	let created = 0, existed = 0;
	for (const plan of plans) {
		const mint = new PublicKey(plan.market.mint);
		// Which ATAs are missing? (batched existence check)
		const missing: any[] = [];
		const infos = await connection.getMultipleAccountsInfo(plan.holders.map((h: any) => h.ata));
		plan.holders.forEach((h: any, i: number) => (infos[i] ? existed++ : missing.push(h)));
		console.log(`==> ${plan.market.index}-${plan.market.symbol}: ${plan.holders.length} holders, ${missing.length} ATA(s) to create`);
		for (const batch of chunk(missing, Number(opts.ataBatchSize))) {
			const ixs = batch.map((h: any) =>
				createAssociatedTokenAccountIdempotentInstruction(
					wallet.publicKey, h.ata, h.owner, mint, TOKEN_2022_PROGRAM_ID
				)
			);
			if (opts.dryRun) {
				console.log(`    [dry-run] create ${ixs.length} ATA(s): ${batch.map((h: any) => h.ata.toBase58().slice(0, 6)).join(', ')}`);
				created += ixs.length;
				continue;
			}
			const sig = await provider.sendAndConfirm(new Transaction().add(...ixs));
			created += ixs.length;
			console.log(`    created ${ixs.length}  sig=${sig}`);
		}
		console.log();
	}
	console.log(`==> create-atas done: ${created} created${opts.dryRun ? ' (dry-run)' : ''}, ${existed} already existed`);
	console.log(opts.dryRun ? '    (dry-run — nothing sent)' : '    next: run without --create-atas to propose the transfers');
}

// ---- Phase 2: ONE Squads Batch (single proposal) ---------------------------
async function runPropose(provider: AnchorProvider, plans: any[], multisigPda: PublicKey, vaultPda: PublicKey, vaultIndex: number, opts: any) {
	const { connection, wallet } = provider;
	console.log(`    multisig  ${multisigPda.toBase58()}`);
	console.log(`    vault[${vaultIndex}]  ${vaultPda.toBase58()}  (token source)`);
	console.log();

	// Preflight: every destination ATA must already exist, else the transfer
	// reverts at execution time. Also verify the vault source ATA holds enough.
	for (const plan of plans) {
		const infos = await connection.getMultipleAccountsInfo(plan.holders.map((h: any) => h.ata));
		const missing = plan.holders.filter((_: any, i: number) => !infos[i]);
		if (missing.length) {
			throw new Error(`${plan.market.symbol}: ${missing.length} destination ATA(s) missing — run --create-atas first`);
		}
		const need = plan.holders.reduce((a: bigint, h: any) => a + h.amount, 0n);
		const bal = BigInt((await connection.getTokenAccountBalance(plan.vaultAta)).value.amount);
		if (bal < need) throw new Error(`${plan.market.symbol}: vault ATA ${plan.vaultAta.toBase58()} holds ${bal} < needed ${need}`);
	}

	// Build the inner batch transactions: chunk each market's holders into
	// single-mint TransactionMessages of ≤ batch-size transfers (so each inner
	// tx fits one ~1232-byte execute tx). All inner txs go under ONE batch.
	type Inner = { symbol: string; count: number; total: bigint; dec: number; message: TransactionMessage };
	const inners: Inner[] = [];
	let grandHolders = 0;
	for (const plan of plans) {
		const mint = new PublicKey(plan.market.mint);
		const dec = plan.market.decimals;
		for (const batch of chunk(plan.holders, Number(opts.batchSize))) {
			const ixs: TransactionInstruction[] = batch.map((h: any) =>
				createTransferCheckedInstruction(plan.vaultAta, mint, h.ata, vaultPda, h.amount, dec, [], TOKEN_2022_PROGRAM_ID)
			);
			const total = batch.reduce((a: bigint, h: any) => a + h.amount, 0n);
			// recentBlockhash is a placeholder; batchAddTransaction stores the
			// message, it is not signed/sent as a standalone tx.
			const message = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs });
			inners.push({ symbol: plan.market.symbol, count: batch.length, total, dec, message });
			grandHolders += batch.length;
		}
	}

	console.log(`==> ONE batch: ${grandHolders} transfers across ${plans.length} market(s) in ${inners.length} inner transaction(s)`);
	for (const inner of inners) console.log(`    - ${inner.symbol}: ${inner.count} transfers (${fmtAmount(inner.total, inner.dec)})`);
	console.log();

	if (opts.dryRun) {
		console.log(`    [dry-run] would batchCreate + proposalCreate(draft) + ${inners.length}x batchAddTransaction + proposalActivate`);
		console.log(`    (dry-run — nothing submitted)`);
		return;
	}

	const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
	const batchIndex = BigInt(ms.transactionIndex.toString()) + 1n;

	// 1. Create the batch + its proposal (as a draft so transactions can be added).
	const createIx = multisig.instructions.batchCreate({ multisigPda, creator: wallet.publicKey, batchIndex, vaultIndex, memo: `IF Token-2022 distribution (${grandHolders} transfers)` });
	const proposeIx = multisig.instructions.proposalCreate({ multisigPda, transactionIndex: batchIndex, creator: wallet.publicKey, isDraft: true });
	let sig = await provider.sendAndConfirm(new Transaction().add(createIx, proposeIx));
	console.log(`==> batchCreate + proposalCreate(draft) batchIndex=${batchIndex} sig=${sig}`);

	// 2. Add each inner transaction (1-based index within the batch).
	for (let i = 0; i < inners.length; i++) {
		const addIx = multisig.instructions.batchAddTransaction({
			vaultIndex, multisigPda, member: wallet.publicKey, batchIndex,
			transactionIndex: i + 1, ephemeralSigners: 0, transactionMessage: inners[i].message,
		});
		sig = await provider.sendAndConfirm(new Transaction().add(addIx));
		console.log(`    + inner ${i + 1}/${inners.length} (${inners[i].symbol}, ${inners[i].count} transfers) sig=${sig}`);
	}

	// 3. Activate the proposal so members can vote.
	const activateIx = multisig.instructions.proposalActivate({ multisigPda, transactionIndex: batchIndex, member: wallet.publicKey });
	sig = await provider.sendAndConfirm(new Transaction().add(activateIx));
	console.log(`==> proposalActivate sig=${sig}`);

	console.log();
	console.log(`==> Done. ONE proposal (batchIndex ${batchIndex}) with ${inners.length} inner transactions, ${grandHolders} transfers total.`);
	console.log(`    Members approve the single proposal, then execute each inner transaction (batchExecuteTransaction) via the Squads UI/CLI.`);
}

main().catch((e) => {
	console.error(`\nERROR: ${e.message ?? e}`);
	process.exit(1);
});
