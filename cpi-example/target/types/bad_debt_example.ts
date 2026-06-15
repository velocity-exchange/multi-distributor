export type BadDebtExample = {
  "version": "0.1.0",
  "name": "bad_debt_example",
  "instructions": [
    {
      "name": "initialize",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "First caller wins; a real program would gate this on an upgrade authority or",
            "derive admin from existing state."
          ]
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "claimDfx",
      "docs": [
        "Claim this program's DFX allocation.",
        "",
        "Permissionless crank: tokens can only land in the bad debt PDA's token account,",
        "so there is no benefit to restricting the caller. `amount` and `proof` come from",
        "the distributor API's `/eligibility/<bad_debt_pda>` endpoint (`end_amount`,",
        "`proof`); the amount can't be wrong, since it's part of the merkle leaf the proof",
        "is verified against."
      ],
      "accounts": [
        {
          "name": "payer",
          "isMut": true,
          "isSigner": true,
          "docs": [
            "Pays the ClaimStatus rent (pre-funded so the claimant PDA never pays)."
          ]
        },
        {
          "name": "distributor",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "claimStatus",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "distributor program, which initializes and validates it."
          ]
        },
        {
          "name": "from",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "The distributor's vault."
          ]
        },
        {
          "name": "to",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "Where the claimed DFX lands; must be owned by the bad debt PDA."
          ]
        },
        {
          "name": "badDebtAuthority",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "via seeds."
          ]
        },
        {
          "name": "merkleDistributorProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "proof",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        }
      ]
    },
    {
      "name": "withdraw",
      "docs": [
        "Withdraw claimed DFX out of the bad debt PDA's token account. Admin only.",
        "Pass `u64::MAX` to withdraw the full balance."
      ],
      "accounts": [
        {
          "name": "config",
          "isMut": false,
          "isSigner": false,
          "relations": [
            "admin"
          ]
        },
        {
          "name": "admin",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "badDebtAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "from",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "destination",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "publicKey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "Unauthorized",
      "msg": "Signer is not the configured admin"
    }
  ]
};

export const IDL: BadDebtExample = {
  "version": "0.1.0",
  "name": "bad_debt_example",
  "instructions": [
    {
      "name": "initialize",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "First caller wins; a real program would gate this on an upgrade authority or",
            "derive admin from existing state."
          ]
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": []
    },
    {
      "name": "claimDfx",
      "docs": [
        "Claim this program's DFX allocation.",
        "",
        "Permissionless crank: tokens can only land in the bad debt PDA's token account,",
        "so there is no benefit to restricting the caller. `amount` and `proof` come from",
        "the distributor API's `/eligibility/<bad_debt_pda>` endpoint (`end_amount`,",
        "`proof`); the amount can't be wrong, since it's part of the merkle leaf the proof",
        "is verified against."
      ],
      "accounts": [
        {
          "name": "payer",
          "isMut": true,
          "isSigner": true,
          "docs": [
            "Pays the ClaimStatus rent (pre-funded so the claimant PDA never pays)."
          ]
        },
        {
          "name": "distributor",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "claimStatus",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "distributor program, which initializes and validates it."
          ]
        },
        {
          "name": "from",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "The distributor's vault."
          ]
        },
        {
          "name": "to",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "Where the claimed DFX lands; must be owned by the bad debt PDA."
          ]
        },
        {
          "name": "badDebtAuthority",
          "isMut": true,
          "isSigner": false,
          "docs": [
            "via seeds."
          ]
        },
        {
          "name": "merkleDistributorProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "proof",
          "type": {
            "vec": {
              "array": [
                "u8",
                32
              ]
            }
          }
        }
      ]
    },
    {
      "name": "withdraw",
      "docs": [
        "Withdraw claimed DFX out of the bad debt PDA's token account. Admin only.",
        "Pass `u64::MAX` to withdraw the full balance."
      ],
      "accounts": [
        {
          "name": "config",
          "isMut": false,
          "isSigner": false,
          "relations": [
            "admin"
          ]
        },
        {
          "name": "admin",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "badDebtAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "from",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "destination",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "publicKey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "Unauthorized",
      "msg": "Signer is not the configured admin"
    }
  ]
};
