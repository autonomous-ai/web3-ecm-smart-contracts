import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import { LambdaEscrow } from '../target/types/lambda_escrow';
import { PublicKey, SystemProgram, Transaction, Connection, Commitment } from '@solana/web3.js';
import {TOKEN_PROGRAM_ID, Token} from '@solana/spl-token';
import { assert } from 'chai';

describe('lambda-escrow', () => {

  // Configure the client to use the local cluster.
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.LambdaEscrow as Program<LambdaEscrow>;

  // Token & PDA
  let mintA = null as Token;
  let buyerTokenAccountA = null;
  let sellerTokenAccountA = null;
  let vault_account_pda = null;
  let vault_account_bump = null;
  let vault_authority_pda = null;

  const amount = 1000;
  const amountPartial = 500;
  const orderCode = 99;
  const trialDay = 0;

  // Account
  const payer = anchor.web3.Keypair.generate();
  const buyer = anchor.web3.Keypair.generate();
  const seller = anchor.web3.Keypair.generate();
  const judge = anchor.web3.Keypair.generate();
  const escrowAccount = anchor.web3.Keypair.generate();
  const mintAuthority = anchor.web3.Keypair.generate();
  

  // 1000 --> buyer
  it('Initialize program state', async () => {
    // Airdrop Sol to payer.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(payer.publicKey, 10000000000),
      "processed"
    );

    // Fund Sol to accounts test.
    await provider.send(
      (() => {
        const tx = new Transaction();
        tx.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: buyer.publicKey,
            lamports: 1000000000, // 1 sol = 10^9 lamports
          }),
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: seller.publicKey,
            lamports: 1000000000, // 1 sol = 10^9 lamports
          }),
        );
        return tx;
      })(), 
      [payer]
    );

    // Create Token A
    mintA = await Token.createMint(
      provider.connection,
      payer,
      mintAuthority.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    // Create account-token belong to Token A
    buyerTokenAccountA = await mintA.createAccount(buyer.publicKey);
    sellerTokenAccountA = await mintA.createAccount(seller.publicKey);

    // Fund Token A to account-token
    await mintA.mintTo(
      buyerTokenAccountA,
      mintAuthority.publicKey,
      [mintAuthority],
      amount
    );

    // check
    let _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    assert.ok(_buyerTokenAccountA.amount.toNumber() == amount);
  }); // buyer: 1000, seller: 0


  it("Initialize escrow", async () => {
    // Init vault account
    const [_vault_account_pda, _vault_account_bump] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("token-seed-" + orderCode.toString()))],
      program.programId
    );
    vault_account_pda = _vault_account_pda;
    vault_account_bump = _vault_account_bump;

    const [_vault_authority_pda, _vault_authority_bump] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("escrow-" + orderCode.toString()))],
      program.programId
    );
    vault_authority_pda = _vault_authority_pda;

    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amount),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // Get data info from Blockchain.
    let _vault = await mintA.getAccountInfo(vault_account_pda);
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount);

    // Check that the new owner is the PDA.
    assert.ok(_vault.owner.equals(vault_authority_pda));

    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.buyerKey.equals(buyer.publicKey));
    assert.ok(_escrowAccount.buyerDepositTokenAccount.equals(buyerTokenAccountA));
    assert.ok(_escrowAccount.judgeKey.equals(judge.publicKey));
    assert.ok(_escrowAccount.amount.toNumber() == amount);
    assert.ok(_escrowAccount.orderCode.toNumber() == orderCode);
    assert.ok(_escrowAccount.status.toString() == "0");
    assert.ok(_escrowAccount.deliveryTime.toNumber() > 0);
    assert.ok(_escrowAccount.trialDay == trialDay);
    // console.log("_escrowAccount.deliveryTime:", _escrowAccount.deliveryTime.toNumber());
    // console.log("_escrowAccount.deliveryTime:", _escrowAccount.deliveryTime.toString(10));
  });

  it("Shipping escrow state", async () => {
    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // Get data info from Blockchain.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount);

    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.buyerKey.equals(buyer.publicKey));
    assert.ok(_escrowAccount.buyerDepositTokenAccount.equals(buyerTokenAccountA));
    assert.ok(_escrowAccount.judgeKey.equals(judge.publicKey));
    assert.ok(_escrowAccount.amount.toNumber() == amount);
    assert.ok(_escrowAccount.orderCode.toNumber() == orderCode);
    assert.ok(_escrowAccount.status.toString() == "1");
  });

  it("Delivered escrow state", async () => {
    // call delivered.
    await program.rpc.delivered(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );

    // Get data info from Blockchain.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount);

    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.buyerKey.equals(buyer.publicKey));
    assert.ok(_escrowAccount.buyerDepositTokenAccount.equals(buyerTokenAccountA));
    assert.ok(_escrowAccount.judgeKey.equals(judge.publicKey));
    assert.ok(_escrowAccount.amount.toNumber() == amount);
    assert.ok(_escrowAccount.orderCode.toNumber() == orderCode);
    assert.ok(_escrowAccount.status.toString() == "2");
  });

  it("Exchange escrow state", async () => {
    // call exchange.
    await program.rpc.exchange({
      accounts: {
        buyer: buyer.publicKey,
        buyerDepositTokenAccount: buyerTokenAccountA,
        seller: seller.publicKey,
        sellerReceiveTokenAccount: sellerTokenAccountA,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller]
    });

    // Get data info from Blockchain.
    let _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    let _sellerTokenAccountA = await mintA.getAccountInfo(sellerTokenAccountA);

    // Check
    assert.ok(_buyerTokenAccountA.amount.toNumber() == 0);
    assert.ok(_sellerTokenAccountA.amount.toNumber() == amount);
  }); // buyer: 0, seller: 1000

  // 1000 --> buyer
  it("Initialize escrow and cancel escrow", async () => {
    // Put back tokens into buyer token A account.
    await mintA.mintTo(
      buyerTokenAccountA,
      mintAuthority.publicKey,
      [mintAuthority],
      amount
    );

    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amount),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // Cancel the escrow.
    await program.rpc.cancel(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );

    // Check the final owner should be the provider public key.
    const _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountA);
    assert.ok(_buyerTokenAccountA.owner.equals(buyer.publicKey));

    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountA.amount.toNumber() == amount);
  }); // buyer: 1000, seller: 1000

  it("Initialize escrow, shipping, refund and cancel escrow", async () => {

    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amount),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call refund
    await program.rpc.refund(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // Get data info from Blockchain.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount);

    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.buyerKey.equals(buyer.publicKey));
    assert.ok(_escrowAccount.buyerDepositTokenAccount.equals(buyerTokenAccountA));
    assert.ok(_escrowAccount.judgeKey.equals(judge.publicKey));
    assert.ok(_escrowAccount.amount.toNumber() == amount);
    assert.ok(_escrowAccount.orderCode.toNumber() == orderCode);
    assert.ok(_escrowAccount.status.toString() == "0");

    // Cancel the escrow.
    await program.rpc.cancel(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );

    // Check the final owner should be the provider public key.
    const _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountA);
    assert.ok(_buyerTokenAccountA.owner.equals(buyer.publicKey));

    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountA.amount.toNumber() == amount);
  }); // buyer: 1000, seller: 1000

  it("Initialize escrow, shipping, adjudge status for Buyer and cancel escrow", async () => {

    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amount),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call adjudge
    const status = 0;
    await program.rpc.adjudge(
      new anchor.BN(orderCode),
      new anchor.BN(status),
      {
        accounts: {
          judge: judge.publicKey,
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [judge]
      }
    );

    // Get data info from Blockchain.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount);

    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.buyerKey.equals(buyer.publicKey));
    assert.ok(_escrowAccount.buyerDepositTokenAccount.equals(buyerTokenAccountA));
    assert.ok(_escrowAccount.judgeKey.equals(judge.publicKey));
    assert.ok(_escrowAccount.amount.toNumber() == amount);
    assert.ok(_escrowAccount.orderCode.toNumber() == orderCode);
    assert.ok(_escrowAccount.status.toString() == "0");

    // Cancel the escrow.
    await program.rpc.cancel(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );

    // Check the final owner should be the provider public key.
    const _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountA);
    assert.ok(_buyerTokenAccountA.owner.equals(buyer.publicKey));

    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountA.amount.toNumber() == amount);
  }); // buyer: 1000, seller: 1000

  it("Initialize escrow, shipping, adjudge status for Seller and exchange escrow", async () => {

    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amount),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call adjudge
    const status = 2;
    await program.rpc.adjudge(
      new anchor.BN(orderCode),
      new anchor.BN(status),
      {
        accounts: {
          judge: judge.publicKey,
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [judge]
      }
    );

    // Get data info from Blockchain.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount);

    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.buyerKey.equals(buyer.publicKey));
    assert.ok(_escrowAccount.buyerDepositTokenAccount.equals(buyerTokenAccountA));
    assert.ok(_escrowAccount.judgeKey.equals(judge.publicKey));
    assert.ok(_escrowAccount.amount.toNumber() == amount);
    assert.ok(_escrowAccount.orderCode.toNumber() == orderCode);
    assert.ok(_escrowAccount.status.toString() == "2");

    // call exchange.
    await program.rpc.exchange({
      accounts: {
        buyer: buyer.publicKey,
        buyerDepositTokenAccount: buyerTokenAccountA,
        seller: seller.publicKey,
        sellerReceiveTokenAccount: sellerTokenAccountA,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller]
    });

    // Get data info from Blockchain.
    let _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountA);
    let _sellerTokenAccountA = await mintA.getAccountInfo(sellerTokenAccountA);
    // console.log(_sellerTokenAccountA);

    // Check
    assert.ok(_buyerTokenAccountA.amount.toNumber() == 0);
    assert.ok(_sellerTokenAccountA.amount.toNumber() == (amount*2));
  }); // buyer: 0, seller: 2000


  // 2000 --> buyer
  it("Initialize escrow twice and cancel escrow twice", async () => {
    // Put back tokens into buyer token A account.
    await mintA.mintTo(
      buyerTokenAccountA,
      mintAuthority.publicKey,
      [mintAuthority],
      amount*2
    );

    // Init new inputs.
    const escrowAccount2 = anchor.web3.Keypair.generate();
    const escrowAccount3 = anchor.web3.Keypair.generate();
    const orderCode2 = orderCode + 1;
    const orderCode3 = orderCode + 2;
    let vault_account_pda2 = null;
    let vault_account_bump2 = null;
    let vault_authority_pda2 = null;
    let vault_account_pda3 = null;
    let vault_account_bump3 = null;
    let vault_authority_pda3 = null;

    // Init vault account
    const [_vault_account_pda2, _vault_account_bump2] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("token-seed-" + orderCode2.toString()))],
      program.programId
    );
    vault_account_pda2 = _vault_account_pda2;
    vault_account_bump2 = _vault_account_bump2;
    const [_vault_authority_pda2, _vault_authority_bump2] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("escrow-" + orderCode2.toString()))],
      program.programId
    );
    vault_authority_pda2 = _vault_authority_pda2;

    const [_vault_account_pda3, _vault_account_bump3] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("token-seed-" + orderCode3.toString()))],
      program.programId
    );
    vault_account_pda3 = _vault_account_pda3;
    vault_account_bump3 = _vault_account_bump3;
    const [_vault_authority_pda3, _vault_authority_bump3] = await PublicKey.findProgramAddress(
      [Buffer.from(anchor.utils.bytes.utf8.encode("escrow-" + orderCode3.toString()))],
      program.programId
    );
    vault_authority_pda3 = _vault_authority_pda3;
    
    // console.log("vault_account_pda2:", vault_account_pda2.toBase58());
    // console.log("vault_authority_pda2:", vault_authority_pda2.toBase58());
    // console.log("vault_account_pda3:", vault_account_pda3.toBase58());
    // console.log("vault_authority_pda3:", vault_authority_pda3.toBase58());
    
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump2,
      new anchor.BN(amount),
      new anchor.BN(orderCode2),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda2,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount2.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount2),
        ],
        signers: [escrowAccount2, buyer],
      }
    );
    await program.rpc.initialize(
      vault_account_bump3,
      new anchor.BN(amount),
      new anchor.BN(orderCode3),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda3,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount3.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount3),
        ],
        signers: [escrowAccount3, buyer],
      }
    );

    // Cancel the escrow.
    await program.rpc.cancel(
      new anchor.BN(orderCode2),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda2,
          vaultAuthority: vault_authority_pda2,
          escrowAccount: escrowAccount2.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );
    await program.rpc.cancel(
      new anchor.BN(orderCode3),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda3,
          vaultAuthority: vault_authority_pda3,
          escrowAccount: escrowAccount3.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );

    // Check the final owner should be the provider public key.
    const _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountA);
    assert.ok(_buyerTokenAccountA.owner.equals(buyer.publicKey));

    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountA.amount.toNumber() == (2*amount));
  }); // buyer: 2000, seller: 2000

  
  it("Initialize escrow, cancel partial and cancel escrow", async () => {
    // const escrowAccountPartial = anchor.web3.Keypair.generate();
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amount),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // Cancel Partial the escrow.
    await program.rpc.cancelPartial(
      new anchor.BN(orderCode),
      new anchor.BN(amountPartial),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountAPartial = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountAPartial.amount.toNumber());
    assert.ok(_buyerTokenAccountAPartial.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountAPartial.amount.toNumber() == (amount + amountPartial));
    // Check Escrow Account.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount.amount.toNumber());
    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.amount.toNumber() == (amount - amountPartial));


    // Cancel the escrow.
    await program.rpc.cancel(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountA.amount.toNumber() == (amount*2));
  }); // buyer: 2000, seller: 2000

  it("Initialize escrow, shipping, refund partial, refund and cancel escrow", async () => {
    // const escrowAccountPartial = anchor.web3.Keypair.generate();
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amount),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call refund partial
    await program.rpc.refundPartial(
      new anchor.BN(orderCode),
      new anchor.BN(amountPartial),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountAPartial = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountAPartial.amount.toNumber());
    assert.ok(_buyerTokenAccountAPartial.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountAPartial.amount.toNumber() == (amount + amountPartial));
    // Check Escrow Account.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount.amount.toNumber());
    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.amount.toNumber() == (amount - amountPartial));

    // call refund
    await program.rpc.refund(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // Cancel the escrow.
    await program.rpc.cancel(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountA.amount.toNumber() == (amount*2));
  }); // buyer: 2000, seller: 2000

  it("Initialize escrow, cancel partial, shipping, delivered and exchange escrow", async () => {
    // const escrowAccountPartial = anchor.web3.Keypair.generate();
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amount),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // Cancel Partial the escrow.
    await program.rpc.cancelPartial(
      new anchor.BN(orderCode),
      new anchor.BN(amountPartial),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountAPartial = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountAPartial.amount.toNumber());
    assert.ok(_buyerTokenAccountAPartial.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountAPartial.amount.toNumber() == (amount + amountPartial));
    // Check Escrow Account.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount.amount.toNumber());
    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.amount.toNumber() == (amount - amountPartial));

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call delivered.
    await program.rpc.delivered(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );

    // call exchange.
    await program.rpc.exchange({
      accounts: {
        buyer: buyer.publicKey,
        buyerDepositTokenAccount: buyerTokenAccountA,
        seller: seller.publicKey,
        sellerReceiveTokenAccount: sellerTokenAccountA,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller]
    });

    // Get data info from Blockchain.
    let _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    let _sellerTokenAccountA = await mintA.getAccountInfo(sellerTokenAccountA);
    // Check
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.amount.toNumber() == (amount + amountPartial));
    // console.log(_sellerTokenAccountA.amount.toNumber());
    assert.ok(_sellerTokenAccountA.amount.toNumber() == (amount*3 - amountPartial));
  }); // buyer: 1500, seller: 2500

  it("Initialize escrow, shipping, refund partial, delivered and exchange escrow", async () => {
    // const escrowAccountPartial = anchor.web3.Keypair.generate();
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amount),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call refund partial
    await program.rpc.refundPartial(
      new anchor.BN(orderCode),
      new anchor.BN(amountPartial),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountAPartial = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountAPartial.amount.toNumber());
    assert.ok(_buyerTokenAccountAPartial.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountAPartial.amount.toNumber() == (2*amountPartial));
    // Check Escrow Account.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount.amount.toNumber());
    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.amount.toNumber() == (amount - amountPartial));

    // call delivered.
    await program.rpc.delivered(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );

    // call exchange.
    await program.rpc.exchange({
      accounts: {
        buyer: buyer.publicKey,
        buyerDepositTokenAccount: buyerTokenAccountA,
        seller: seller.publicKey,
        sellerReceiveTokenAccount: sellerTokenAccountA,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller]
    });

    // Get data info from Blockchain.
    let _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    let _sellerTokenAccountA = await mintA.getAccountInfo(sellerTokenAccountA);
    // Check
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.amount.toNumber() == (2*amountPartial));
    // console.log(_sellerTokenAccountA.amount.toNumber());
    assert.ok(_sellerTokenAccountA.amount.toNumber() == (amount*4 - 2*amountPartial));
  }); // buyer: 1000, seller: 3000

  it("Initialize escrow, shipping, adjudge partial, refund and cancel escrow", async () => {
    // const escrowAccountPartial = anchor.web3.Keypair.generate();
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amountPartial*2),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call adjudge partial
    await program.rpc.adjudgePartial(
      new anchor.BN(orderCode),
      new anchor.BN(amountPartial),
      {
        accounts: {
          judge: judge.publicKey,
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [judge]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountAPartial = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountAPartial.amount.toNumber());
    assert.ok(_buyerTokenAccountAPartial.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountAPartial.amount.toNumber() == amountPartial);
    // Check Escrow Account.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount.amount.toNumber());
    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.amount.toNumber() == amountPartial);

    // call refund
    await program.rpc.refund(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // Cancel the escrow.
    await program.rpc.cancel(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountA.amount.toNumber() == (amountPartial*2));
  }); // buyer: 1000, seller: 3000

  it("Initialize escrow, shipping, adjudge partial, delivered and exchange escrow", async () => {
    // const escrowAccountPartial = anchor.web3.Keypair.generate();
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amountPartial*2),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call adjudge partial
    await program.rpc.adjudgePartial(
      new anchor.BN(orderCode),
      new anchor.BN(amountPartial),
      {
        accounts: {
          judge: judge.publicKey,
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [judge]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountAPartial = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountAPartial.amount.toNumber());
    assert.ok(_buyerTokenAccountAPartial.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountAPartial.amount.toNumber() == amountPartial);
    // Check Escrow Account.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount.amount.toNumber());
    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.amount.toNumber() == amountPartial);

    // call delivered.
    await program.rpc.delivered(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );

    // call exchange.
    await program.rpc.exchange({
      accounts: {
        buyer: buyer.publicKey,
        buyerDepositTokenAccount: buyerTokenAccountA,
        seller: seller.publicKey,
        sellerReceiveTokenAccount: sellerTokenAccountA,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller]
    });

    // Get data info from Blockchain.
    let _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    let _sellerTokenAccountA = await mintA.getAccountInfo(sellerTokenAccountA);
    // Check
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.amount.toNumber() == amountPartial);
    // console.log(_sellerTokenAccountA.amount.toNumber());
    assert.ok(_sellerTokenAccountA.amount.toNumber() == (amount*4 - amountPartial));
  }); // buyer: 500, seller: 3500

  it("Initialize escrow, shipping and adjudge escrow for Buyer", async () => {
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amountPartial),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call adjudge for buyer
    await program.rpc.adjudgeForBuyer(
      new anchor.BN(orderCode),
      {
        accounts: {
          judge: judge.publicKey,
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [judge]
      }
    );

    // Get data info from Blockchain.
    let _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    let _sellerTokenAccountA = await mintA.getAccountInfo(sellerTokenAccountA);
    // Check
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.amount.toNumber() == amountPartial);
    // console.log(_sellerTokenAccountA.amount.toNumber());
    assert.ok(_sellerTokenAccountA.amount.toNumber() == (amount*4 - amountPartial));
  }); // buyer: 500, seller: 3500

  it("Initialize escrow, shipping and adjudge escrow for Seller", async () => {
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amountPartial),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // call adjudge for seller
    await program.rpc.adjudgeForSeller(
      new anchor.BN(orderCode),
      {
        accounts: {
          judge: judge.publicKey,
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [judge]
      }
    );

    // Get data info from Blockchain.
    let _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    let _sellerTokenAccountA = await mintA.getAccountInfo(sellerTokenAccountA);
    // Check
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.amount.toNumber() == 0);
    // console.log(_sellerTokenAccountA.amount.toNumber());
    assert.ok(_sellerTokenAccountA.amount.toNumber() == (amount*4));
  }); // buyer: 0, seller: 4000


  // 1000 --> buyer
  it("Initialize escrow, charge more and cancel escrow", async () => {
    // Put back tokens into buyer token A account.
    await mintA.mintTo(
      buyerTokenAccountA,
      mintAuthority.publicKey,
      [mintAuthority],
      amount
    );

    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amountPartial),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // Charge More buyer.
    await program.rpc.chargeMore(
      new anchor.BN(orderCode),
      new anchor.BN(amountPartial),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountAPartial = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountAPartial.amount.toNumber());
    assert.ok(_buyerTokenAccountAPartial.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountAPartial.amount.toNumber() == (amount - 2*amountPartial));
    // Check Escrow Account.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount.amount.toNumber());
    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.amount.toNumber() == (2*amountPartial));


    // Cancel the escrow.
    await program.rpc.cancel(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountA.amount.toNumber() == amount);
  }); // buyer: 1000, seller: 4000

  it("Initialize escrow, shipping, charge more, delivered and exchange escrow", async () => {
    // Init account escrow
    await program.rpc.initialize(
      vault_account_bump,
      new anchor.BN(amountPartial),
      new anchor.BN(orderCode),
      new anchor.BN(trialDay),
      {
        accounts: {
          buyer: buyer.publicKey,
          seller: seller.publicKey,
          judge: judge.publicKey,
          mint: mintA.publicKey,
          vaultAccount: vault_account_pda,
          buyerDepositTokenAccount: buyerTokenAccountA,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [
          await program.account.escrowAccount.createInstruction(escrowAccount),
        ],
        signers: [escrowAccount, buyer],
      }
    );

    // call shipping.
    await program.rpc.shipping(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller]
      }
    );

    // Charge More buyer.
    await program.rpc.chargeMore(
      new anchor.BN(orderCode),
      new anchor.BN(amountPartial),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          vaultAccount: vault_account_pda,
          vaultAuthority: vault_authority_pda,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );
    // Check the final owner should be the provider public key.
    const _buyerTokenAccountAPartial = await mintA.getAccountInfo(buyerTokenAccountA);
    // console.log(_buyerTokenAccountAPartial.amount.toNumber());
    assert.ok(_buyerTokenAccountAPartial.owner.equals(buyer.publicKey));
    // Check all the funds token A are still there.
    assert.ok(_buyerTokenAccountAPartial.amount.toNumber() == (amount - 2*amountPartial));
    // Check Escrow Account.
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);
    // console.log(_escrowAccount.amount.toNumber());
    // Check that the values in the escrow account match what we expect.
    assert.ok(_escrowAccount.amount.toNumber() == (2*amountPartial));

    // call delivered.
    await program.rpc.delivered(
      new anchor.BN(orderCode),
      {
        accounts: {
          buyer: buyer.publicKey,
          buyerDepositTokenAccount: buyerTokenAccountA,
          seller: seller.publicKey,
          sellerReceiveTokenAccount: sellerTokenAccountA,
          escrowAccount: escrowAccount.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [buyer]
      }
    );

    // call exchange.
    await program.rpc.exchange({
      accounts: {
        buyer: buyer.publicKey,
        buyerDepositTokenAccount: buyerTokenAccountA,
        seller: seller.publicKey,
        sellerReceiveTokenAccount: sellerTokenAccountA,
        escrowAccount: escrowAccount.publicKey,
        vaultAccount: vault_account_pda,
        vaultAuthority: vault_authority_pda,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller]
    });

    // Get data info from Blockchain.
    let _buyerTokenAccountA = await mintA.getAccountInfo(buyerTokenAccountA);
    let _sellerTokenAccountA = await mintA.getAccountInfo(sellerTokenAccountA);
    // Check
    // console.log(_buyerTokenAccountA.amount.toNumber());
    assert.ok(_buyerTokenAccountA.amount.toNumber() == (amount - 2*amountPartial));
    // console.log(_sellerTokenAccountA.amount.toNumber());
    assert.ok(_sellerTokenAccountA.amount.toNumber() == (amount*4 + 2*amountPartial));
  }); // buyer: 0, seller: 5000

});
