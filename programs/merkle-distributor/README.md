# Drift Insurance Fund Claims Program

An Anchor program for distributing token claims from program-owned vaults using Merkle proofs.

For the IF claim flow, each distributor is configured for a single mint and Merkle root. Claim leaves should be generated at authority level with the full withdrawable amount in `amount_unlocked` and zero `amount_locked`.

The program is based on Merkle distributor designs from Uniswap, Saber, Jito, and Jupiter, with Drift-specific deployment metadata and operational tooling.
