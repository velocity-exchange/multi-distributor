use crate::*;
use solana_sdk::compute_budget::ComputeBudgetInstruction;

pub fn process_fund_all(args: &Args, fund_all_args: &FundAllArgs) {
    let program = args.get_program_client();
    let client = RpcClient::new_with_commitment(&args.rpc_url, CommitmentConfig::finalized());
    let keypair = read_keypair_file(&args.keypair_path.clone().unwrap())
        .expect("Failed reading keypair file");
    let mut paths: Vec<_> = fs::read_dir(&fund_all_args.merkle_tree_path)
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    paths.sort_by_key(|dir| dir.path());

    let source_vault = get_associated_token_address(&keypair.pubkey(), &args.mint);

    for file in paths {
        let single_tree_path = file.path();

        // Skip directories
        if single_tree_path.is_dir() {
            continue;
        }

        // Skip non-JSON files
        match single_tree_path.extension() {
            Some(ext) if ext == "json" => {
                // Continue processing JSON files
            }
            Some(ext) => {
                println!("skipping non-json file: {}", single_tree_path.display());
                continue;
            }
            None => {
                println!(
                    "skipping file without extension: {}",
                    single_tree_path.display()
                );
                continue;
            }
        }

        let merkle_tree =
            AirdropMerkleTree::new_from_file(&single_tree_path).expect("failed to read");
        let (distributor_pubkey, _bump) =
            get_merkle_distributor_pda(&args.program_id, &args.mint, merkle_tree.airdrop_version);

        let token_vault = get_associated_token_address(&distributor_pubkey, &args.mint);

        // Fund only what is still needed to cover the *remaining* (unclaimed)
        // entitlement. A fully-funded vault holds `max_total_claim -
        // total_amount_claimed`; claims drain the vault below that, so funding
        // the full `max_total_claim` again would over-fund by the amount
        // already claimed. Transferring the deficit instead keeps funding
        // idempotent even after claiming has started.
        let distributor_state: MerkleDistributor = program.account(distributor_pubkey).unwrap();

        // A clawed-back distributor has had its vault drained to the clawback
        // receiver and has both claiming and re-clawback permanently disabled.
        // Funding it would strand the tokens, so skip it.
        if distributor_state.clawed_back {
            println!(
                "skipping clawed-back airdrop version {}",
                merkle_tree.airdrop_version
            );
            continue;
        }

        let target = merkle_tree
            .max_total_claim
            .checked_sub(distributor_state.total_amount_claimed)
            .expect("total_amount_claimed exceeds max_total_claim");

        let token_vault_state: TokenAccount = program.account(token_vault).unwrap();
        if token_vault_state.amount >= target {
            println!(
                "already fund airdrop version {}!",
                merkle_tree.airdrop_version
            );
            continue;
        }
        let fund_amount = target - token_vault_state.amount;

        let mut ixs = vec![];

        let priority_fee = args.priority.unwrap_or(0);
        if priority_fee > 0 {
            let instruction = ComputeBudgetInstruction::set_compute_unit_price(priority_fee);
            ixs.push(instruction);
            println!(
                "Added priority fee instruction of {} microlamports",
                priority_fee
            );
        }

        ixs.push(
            spl_token::instruction::transfer(
                &spl_token::id(),
                &source_vault,
                &token_vault,
                &keypair.pubkey(),
                &[],
                fund_amount,
            )
            .unwrap(),
        );

        let tx = Transaction::new_signed_with_payer(
            &ixs,
            Some(&keypair.pubkey()),
            &[&keypair],
            client.get_latest_blockhash().unwrap(),
        );

        let signature = client.send_transaction(&tx).unwrap();

        println!(
            "Successfully transfer {} to merkle tree with airdrop version {}! signature: {signature:#?}",
            fund_amount,
            merkle_tree.airdrop_version
        );
    }
}
