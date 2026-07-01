#!/usr/bin/env tsx
/**
 * fund-if-msig.ts — Fund Insurance Fund (IF) distributor vaults through a
 * Squads V4 multisig, one market at a time (or all at once).
 *
 * The tokens to fund the airdrop live in a Squads V4 vault, not in a hot
 * keypair, so funding can't use the Rust cli's `fund-all` (which signs an SPL
 * transfer with a local keypair). Instead this builds the exact same transfer —
 *   transfer(vaultAta -> distributorVaultAta, authority = vault PDA, deficit)
 * — and wraps it in a `vaultTransactionCreate` + `proposalCreate` so the
 * multisig members approve + execute it. It mirrors protocol-v2-shadow's
 * cli-admin `sendOrPropose`: the proposer keypair only pays rent and is recorded
 * as creator; it does NOT approve or execute.
 *
 * Funding math matches process_fund_all.rs exactly (idempotent):
 *   target = max_total_claim (from the tree file) - total_amount_claimed (on-chain)
 *   fund   = target - current vault balance      (skipped if <= 0)
 * so re-proposing after a partial fund or after claims have started only tops up
 * the remaining deficit, and a clawed-back distributor is skipped.
 *
 * All funding transfers (across one or every market) go into a SINGLE Squads
 * `Batch` under one proposal: batchCreate + proposalCreate(draft) -> one
 * batchAddTransaction per inner chunk (≤ --batch-size transfers, so each fits
 * the ~1232-byte execute tx) -> proposalActivate. Members approve ONCE, then
 * execute each inner transaction. So `--all` across ~45 markets is one approval,
 * not ~45.
 *
 * Usage (run from this directory after `npm install`):
 *   npm run fund -- --config ../if-markets.mainnet.json \
 *                   --multisig <MULTISIG_PDA> \
 *                   --keypair ~/.config/solana/proposer.json \
 *                   --market mSOL
 *
 *   # by index instead of symbol:           --index 2
 *   # every still-unfunded market:          --all
 *   # preview without sending anything:     --dry-run
 */
import {
	AnchorProvider,
	BN,
	Program,
	Wallet,
	type Idl,
} from '@coral-xyz/anchor';
import {
	createTransferInstruction,
	getAssociatedTokenAddressSync,
	TOKEN_PROGRAM_ID,
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

// IDL ships in the repo's build output; we only need it to decode the
// distributor account (total_amount_claimed, clawed_back).
import idlJson from '../../../target/idl/merkle_distributor.json' assert { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------
// Types describing the (merged) IF config files.
// --------------------------------------------------------------------------
type Market = {
	index: number;
	symbol: string;
	mint: string;
	decimals?: number;
};
type IfConfig = {
	rpc_url?: string;
	program_id: string;
	csv_dir?: string;
	trees_dir?: string;
	exclude_markets?: number[];
	markets: Market[];
};
type TreeFile = {
	airdrop_version: number;
	max_total_claim: number;
};

function expandHome(p: string): string {
	return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p;
}

function loadKeypair(p: string): Keypair {
	const bytes = JSON.parse(fs.readFileSync(expandHome(p), 'utf-8'));
	return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

function readJson<T>(p: string): T {
	return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
}

// PDA: ["MerkleDistributor", mint (32B), version (u64 LE)] — see
// merkle-tree/src/utils.rs::get_merkle_distributor_pda.
function deriveDistributorPda(
	programId: PublicKey,
	mint: PublicKey,
	version: number
): PublicKey {
	const versionLe = Buffer.alloc(8);
	versionLe.writeBigUInt64LE(BigInt(version));
	const [pda] = PublicKey.findProgramAddressSync(
		[Buffer.from('MerkleDistributor'), mint.toBuffer(), versionLe],
		programId
	);
	return pda;
}

function fmtAmount(raw: bigint, decimals?: number): string {
	if (decimals == null) return raw.toString();
	const s = raw.toString().padStart(decimals + 1, '0');
	const whole = s.slice(0, s.length - decimals);
	const frac = s.slice(s.length - decimals).replace(/0+$/, '');
	return frac ? `${whole}.${frac} (${raw} base)` : `${whole} (${raw} base)`;
}

function chunk<T>(arr: T[], n: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
}

// One funding transfer derived from a single tree.
type Transfer = {
	version: number;
	distributor: PublicKey;
	destVault: PublicKey;
	amount: bigint;
};

async function planMarketTransfers(
	connection: Connection,
	program: Program,
	programId: PublicKey,
	market: Market,
	treeDir: string
): Promise<Transfer[]> {
	const mint = new PublicKey(market.mint);
	const label = `${market.index}-${market.symbol}`;

	if (!fs.existsSync(treeDir)) {
		throw new Error(
			`trees dir not found for ${label}: ${treeDir}\n` +
				`  run ./deploy-if.sh first so the distributors + trees exist.`
		);
	}
	const treeFiles = fs
		.readdirSync(treeDir)
		.filter((f) => f.startsWith('tree_') && f.endsWith('.json'))
		.sort();
	if (treeFiles.length === 0) {
		throw new Error(`no tree_*.json files in ${treeDir}`);
	}

	const transfers: Transfer[] = [];
	for (const file of treeFiles) {
		const tree = readJson<TreeFile>(path.join(treeDir, file));
		const distributor = deriveDistributorPda(
			programId,
			mint,
			tree.airdrop_version
		);
		const destVault = getAssociatedTokenAddressSync(
			mint,
			distributor,
			true /* allowOwnerOffCurve: distributor is a PDA */
		);

		// On-chain state: confirms the distributor was deployed, how much has
		// already been claimed, and whether it was clawed back.
		let claimed = 0n;
		let clawedBack = false;
		try {
			const acct: any = await program.account.merkleDistributor.fetch(
				distributor
			);
			claimed = BigInt(acct.totalAmountClaimed.toString());
			clawedBack = acct.clawedBack as boolean;
		} catch (e) {
			throw new Error(
				`${label} v${tree.airdrop_version}: distributor ${distributor.toBase58()} ` +
					`not found on-chain — deploy it before funding.`
			);
		}
		if (clawedBack) {
			console.log(
				`    [${label} v${tree.airdrop_version}] skip: clawed back`
			);
			continue;
		}

		// Once claiming has started, never re-fund from here. Claiming is live
		// (enable_slot + start_ts have passed), so a vault funded now can be
		// drained by claimants before a later `--all` run. The deficit math
		// below would top the vault back up to cover the remaining unclaimed
		// entitlement — correct in the abstract, but we don't want an `--all`
		// run silently re-proposing transfers into an already-live distributor.
		// A genuine top-up should be done deliberately, not as a side effect.
		if (claimed > 0n) {
			console.log(
				`    [${label} v${tree.airdrop_version}] skip: claiming has started ` +
					`(${fmtAmount(claimed, market.decimals)} claimed) — not re-funding`
			);
			continue;
		}

		const maxTotalClaim = BigInt(tree.max_total_claim);
		const target = maxTotalClaim - claimed;

		// Current vault balance (the ATA exists — new-distributor inits it).
		const bal = await connection.getTokenAccountBalance(destVault);
		const have = BigInt(bal.value.amount);

		const fundAmount = target - have;
		if (fundAmount <= 0n) {
			console.log(
				`    [${label} v${tree.airdrop_version}] skip: already funded ` +
					`(vault ${have} >= target ${target})`
			);
			continue;
		}

		transfers.push({
			version: tree.airdrop_version,
			distributor,
			destVault,
			amount: fundAmount,
		});
		console.log(
			`    [${label} v${tree.airdrop_version}] fund ` +
				`${fmtAmount(fundAmount, market.decimals)} -> vault ${destVault.toBase58()}`
		);
	}
	return transfers;
}

async function main() {
	const program = new Command();
	program
		.name('fund-if-msig')
		.description('Propose Squads V4 transactions to fund IF distributor vaults')
		.requiredOption(
			'-m, --multisig <pubkey>',
			'Squads V4 multisig PDA whose vault holds the IF tokens'
		)
		.requiredOption(
			'-k, --keypair <path>',
			'proposer keypair JSON (a multisig member; pays rent, records as creator)'
		)
		.option(
			'-c, --config <path>',
			'IF config JSON (the original, with csv_dir/trees_dir)',
			path.resolve(__dirname, '..', 'if-markets.mainnet.json')
		)
		.option('--market <symbol>', 'fund a single market by symbol (e.g. mSOL)')
		.option('--index <n>', 'fund a single market by index (e.g. 2)')
		.option('--all', 'fund every still-unfunded market (one batch / one proposal)')
		.option('-u, --url <rpc>', 'RPC URL override (default: config.rpc_url)')
		.option('--trees-dir <dir>', 'trees dir override (default: config.trees_dir)')
		.option('--vault-index <n>', 'Squads vault index', '0')
		.option('--batch-size <n>', 'transfers per inner batch-transaction (≤10 fits one execute tx)', '8')
		.option('--dry-run', 'plan + print proposals without sending', false)
		.parse(process.argv);

	const opts = program.opts();

	if (!opts.all && !opts.market && opts.index == null) {
		throw new Error('select a scope: --market <symbol>, --index <n>, or --all');
	}

	// --- load config + resolve dirs (relative to the config file, like the
	// bash scripts which resolve ./data/... from deploy-merkle-trees/). -------
	const configPath = path.resolve(expandHome(opts.config));
	const base = path.dirname(configPath);
	const config = readJson<IfConfig>(configPath);

	const programId = new PublicKey(config.program_id);
	const rpcUrl = opts.url ?? config.rpc_url;
	if (!rpcUrl) throw new Error('no RPC url (pass --url or set rpc_url in config)');

	const csvDir = path.resolve(base, config.csv_dir ?? './if-csv');
	const treesDir = opts.treesDir
		? path.resolve(expandHome(opts.treesDir))
		: path.resolve(base, config.trees_dir ?? './if-trees');

	// Fund against the same by-mint merged view deploy used.
	const mergedConfigPath = path.join(csvDir, 'processed', 'merged-config.json');
	if (!fs.existsSync(mergedConfigPath)) {
		throw new Error(
			`merged config not found: ${mergedConfigPath}\n` +
				`  run ./deploy-if.sh (it writes merged-config.json) before funding.`
		);
	}
	const merged = readJson<IfConfig>(mergedConfigPath);

	// decimals come from the original config (merged-config drops them); used
	// only for human-readable logging.
	const decimalsByMint = new Map<string, number>();
	for (const m of config.markets)
		if (m.decimals != null) decimalsByMint.set(m.mint, m.decimals);

	let markets: Market[] = merged.markets.map((m) => ({
		...m,
		decimals: decimalsByMint.get(m.mint),
	}));

	if (!opts.all) {
		const before = markets.length;
		if (opts.market) {
			const want = String(opts.market).toLowerCase();
			markets = markets.filter((m) => m.symbol.toLowerCase() === want);
		} else {
			const idx = Number(opts.index);
			markets = markets.filter((m) => m.index === idx);
		}
		if (markets.length === 0) {
			throw new Error(
				`no market matched ${opts.market ?? `index ${opts.index}`} ` +
					`(${before} markets in merged config)`
			);
		}
	}

	// --- provider + program -------------------------------------------------
	const connection = new Connection(rpcUrl, 'confirmed');
	const wallet = new Wallet(loadKeypair(opts.keypair));
	const provider = new AnchorProvider(connection, wallet, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const dist = new Program(idlJson as Idl, programId, provider);

	const multisigPda = new PublicKey(opts.multisig);
	const vaultIndex = Number(opts.vaultIndex);
	const [vaultPda] = multisig.getVaultPda({ multisigPda, index: vaultIndex });

	console.log(`==> IF multisig fund`);
	console.log(`    rpc          ${rpcUrl}`);
	console.log(`    program      ${programId.toBase58()}`);
	console.log(`    multisig     ${multisigPda.toBase58()}`);
	console.log(`    vault[${vaultIndex}]     ${vaultPda.toBase58()}  (token source)`);
	console.log(`    proposer     ${wallet.publicKey.toBase58()}`);
	console.log(`    markets      ${markets.map((m) => m.symbol).join(', ')}`);
	console.log(`    dry-run      ${!!opts.dryRun}`);
	console.log();

	// Gather all funding transfers across the selected markets into ONE flat
	// list (read-only planning). Each market may emit 0+ transfers (one per tree
	// still under-funded); a market with nothing to fund is skipped.
	const allIxs: TransactionInstruction[] = [];
	let grandTotalTransfers = 0;
	let skipped = 0;

	// Markets deferred via config exclude_markets (e.g. Token-2022 mints the
	// distributor program can't take) have no distributor — skip them, matching
	// deploy-if.sh. The original config carries exclude_markets; the merged
	// config keeps the same per-mint indices.
	const excluded = new Set<number>((config.exclude_markets ?? []) as number[]);

	for (const market of markets) {
		const label = `${market.index}-${market.symbol}`;
		if (excluded.has(market.index)) {
			console.log(`==> [${label}] skipped (excluded in config)\n`);
			skipped++;
			continue;
		}
		const treeDir = path.join(treesDir, label);
		// 0-claim markets were never deployed (no trees) — skip rather than error.
		const treeFiles = fs.existsSync(treeDir)
			? fs.readdirSync(treeDir).filter((f) => f.startsWith('tree_') && f.endsWith('.json'))
			: [];
		if (treeFiles.length === 0) {
			console.log(`==> [${label}] skipped (no trees on-disk — not deployed)\n`);
			skipped++;
			continue;
		}
		const mint = new PublicKey(market.mint);
		const vaultAta = getAssociatedTokenAddressSync(mint, vaultPda, true);

		console.log(`==> ${label}  mint=${market.mint}`);
		console.log(`    source vault ATA: ${vaultAta.toBase58()}`);

		const transfers = await planMarketTransfers(connection, dist, programId, market, treeDir);
		if (transfers.length === 0) {
			console.log(`    nothing to fund.\n`);
			skipped++;
			continue;
		}
		for (const t of transfers) {
			allIxs.push(
				createTransferInstruction(
					vaultAta,
					t.destVault,
					vaultPda, // authority — the vault PDA signs at execution time
					t.amount,
					[],
					TOKEN_PROGRAM_ID
				)
			);
		}
		const total = transfers.reduce((a, t) => a + t.amount, 0n);
		console.log(`    -> ${transfers.length} transfer(s), ${fmtAmount(total, market.decimals)}\n`);
		grandTotalTransfers += transfers.length;
	}

	if (allIxs.length === 0) {
		console.log(`==> Nothing to fund (${skipped} market(s) already funded / empty).`);
		return;
	}

	// All transfers go into ONE Squads Batch under a single proposal. Chunk into
	// inner transactions of ≤ batch-size so each fits a ~1232-byte execute tx.
	const chunks = chunk(allIxs, Number(opts.batchSize));
	console.log(`==> ONE batch: ${grandTotalTransfers} transfer(s) in ${chunks.length} inner transaction(s) (${skipped} market(s) skipped)`);

	if (opts.dryRun) {
		console.log(`    [dry-run] would batchCreate + proposalCreate(draft) + ${chunks.length}x batchAddTransaction + proposalActivate`);
		console.log(`    (dry-run — nothing was sent)`);
		return;
	}

	const msInfo = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
	const batchIndex = BigInt(msInfo.transactionIndex.toString()) + 1n;

	// 1. Create the batch + its proposal (draft, so transactions can be added).
	const createIx = multisig.instructions.batchCreate({ multisigPda, creator: wallet.publicKey, batchIndex, vaultIndex, memo: `IF fund (${grandTotalTransfers} transfers)` });
	const proposeIx = multisig.instructions.proposalCreate({ multisigPda, transactionIndex: batchIndex, creator: wallet.publicKey, isDraft: true });
	let sig = await provider.sendAndConfirm(new Transaction().add(createIx, proposeIx));
	console.log(`==> batchCreate + proposalCreate(draft) batchIndex=${batchIndex} sig=${sig}`);

	// 2. Add each inner transaction (1-based index within the batch).
	for (let i = 0; i < chunks.length; i++) {
		const { blockhash } = await connection.getLatestBlockhash();
		const message = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: blockhash, instructions: chunks[i] });
		const addIx = multisig.instructions.batchAddTransaction({
			vaultIndex, multisigPda, member: wallet.publicKey, batchIndex,
			transactionIndex: i + 1, ephemeralSigners: 0, transactionMessage: message,
		});
		sig = await provider.sendAndConfirm(new Transaction().add(addIx));
		console.log(`    + inner ${i + 1}/${chunks.length} (${chunks[i].length} transfers) sig=${sig}`);
	}

	// 3. Activate the proposal so members can vote.
	sig = await provider.sendAndConfirm(
		new Transaction().add(multisig.instructions.proposalActivate({ multisigPda, transactionIndex: batchIndex, member: wallet.publicKey }))
	);
	console.log(`==> proposalActivate sig=${sig}`);
	console.log();
	console.log(`==> Done. ONE proposal (batchIndex ${batchIndex}) with ${chunks.length} inner transactions, ${grandTotalTransfers} transfers total.`);
	console.log(`    Members approve the single proposal, then execute each inner transaction (batchExecuteTransaction) via the Squads UI/CLI.`);
}

main().catch((e) => {
	console.error(`\nERROR: ${e.message ?? e}`);
	process.exit(1);
});
