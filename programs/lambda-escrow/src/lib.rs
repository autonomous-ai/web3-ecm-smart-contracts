use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, SetAuthority, TokenAccount, Transfer};
use spl_token::instruction::AuthorityType;


// version 1.0.0
declare_id!("CXWCr2nFZ5yXuewf5t2GFYTT337XmaH8UrhUbS2Hy8tL");


#[program]
pub mod lambda_escrow {
    use super::*;


    pub fn initialize(
        ctx: Context<Initialize>,
        _vault_account_bump: u8,
        amount: u64,
        order_code: u64,
        trial_day: u16,
    ) -> ProgramResult {
        let clock: Clock = Clock::get().unwrap();
        // Init escrow_account
        ctx.accounts.escrow_account.buyer_key = *ctx.accounts.buyer.key;
        ctx.accounts.escrow_account.buyer_deposit_token_account = *ctx.accounts.buyer_deposit_token_account.to_account_info().key;
        ctx.accounts.escrow_account.seller_key = *ctx.accounts.seller.key;
        ctx.accounts.escrow_account.seller_receive_token_account = *ctx.accounts.seller_receive_token_account.to_account_info().key;
        ctx.accounts.escrow_account.judge_key = *ctx.accounts.judge.key;
        ctx.accounts.escrow_account.amount = amount;
        ctx.accounts.escrow_account.order_code = order_code;
        ctx.accounts.escrow_account.status = 0;
        ctx.accounts.escrow_account.delivery_time = clock.unix_timestamp;
        ctx.accounts.escrow_account.trial_day = trial_day;

        // Init PDA
        let escrow_seed: String = format!("{}{}", "escrow-".to_string(), order_code.to_string());
        let escrow_pda_seed: &[u8] = escrow_seed.as_bytes();
        let (vault_authority, _vault_authority_bump) = Pubkey::find_program_address(&[escrow_pda_seed], ctx.program_id);
        token::set_authority(
            ctx.accounts.into_set_authority_context(),
            AuthorityType::AccountOwner,
            Some(vault_authority),
        )?;

        // Transfer token to PDA
        token::transfer(
            ctx.accounts.into_transfer_to_pda_context(),
            ctx.accounts.escrow_account.amount,
        )?;

        Ok(())
    }

    pub fn cancel(ctx: Context<Cancel>, order_code: u64,) -> ProgramResult {
        // Make Seed
        let escrow_seed: String = format!("{}{}", "escrow-".to_string(), order_code.to_string());
        let escrow_pda_seed: &[u8] = escrow_seed.as_bytes();
        let (_vault_authority, vault_authority_bump) = Pubkey::find_program_address(&[escrow_pda_seed], ctx.program_id);
        let authority_seeds = &[&escrow_pda_seed[..], &[vault_authority_bump]];

        // Transfer token to buyer.
        token::transfer(
            ctx.accounts.into_transfer_to_buyer_context().with_signer(&[&authority_seeds[..]]),
            ctx.accounts.escrow_account.amount,
        )?;

        // Close vault account
        token::close_account(
            ctx.accounts.into_close_contest().with_signer(&[&authority_seeds[..]]),
        )?;

        Ok(())
    }
    
    pub fn cancel_partial(ctx: Context<CancelPartial>, order_code: u64, amount: u64,) -> ProgramResult {
        // Make Seed
        let escrow_seed: String = format!("{}{}", "escrow-".to_string(), order_code.to_string());
        let escrow_pda_seed: &[u8] = escrow_seed.as_bytes();
        let (_vault_authority, vault_authority_bump) = Pubkey::find_program_address(&[escrow_pda_seed], ctx.program_id);
        let authority_seeds = &[&escrow_pda_seed[..], &[vault_authority_bump]];

        // Transfer token to buyer.
        token::transfer(
            ctx.accounts.into_transfer_to_buyer_context().with_signer(&[&authority_seeds[..]]),
            amount,
        )?;
        // Update escrow_account
        ctx.accounts.escrow_account.amount -= amount;

        Ok(())
    }

    pub fn charge_more(ctx: Context<ChargeMore>, order_code: u64, amount: u64,) -> ProgramResult {
        if ctx.accounts.escrow_account.order_code == order_code {
            // Transfer token to PDA
            token::transfer(
                ctx.accounts.into_transfer_to_pda_context(),
                amount,
            )?;
            // Update escrow_account
            ctx.accounts.escrow_account.amount += amount;
        }

        Ok(())
    }

    pub fn shipping(ctx: Context<Shipping>, order_code: u64,) -> ProgramResult {
        // Update escrow_account
        if ctx.accounts.escrow_account.order_code == order_code {
            ctx.accounts.escrow_account.status = 1;
        }

        Ok(())
    }

    pub fn delivered(ctx: Context<Delivered>, order_code: u64,) -> ProgramResult {
        // Update escrow_account
        if ctx.accounts.escrow_account.order_code == order_code {
            ctx.accounts.escrow_account.status = 2;
            let clock: Clock = Clock::get().unwrap();
            ctx.accounts.escrow_account.delivery_time = clock.unix_timestamp;
        }

        Ok(())
    }

    pub fn refund(ctx: Context<Refund>, order_code: u64,) -> ProgramResult {
        // If status = Shipping or Delivered, Seller can refund to Buyer.
        if ctx.accounts.escrow_account.order_code == order_code && ctx.accounts.escrow_account.status > 0 {
            // Update escrow_account
            ctx.accounts.escrow_account.status = 0;
        }

        Ok(())
    }

    pub fn refund_partial(ctx: Context<RefundPartial>, order_code: u64, amount: u64,) -> ProgramResult {
        // Make Seed
        let escrow_seed: String = format!("{}{}", "escrow-".to_string(), order_code.to_string());
        let escrow_pda_seed: &[u8] = escrow_seed.as_bytes();
        let (_vault_authority, vault_authority_bump) = Pubkey::find_program_address(&[escrow_pda_seed], ctx.program_id);
        let authority_seeds = &[&escrow_pda_seed[..], &[vault_authority_bump]];

        // Transfer token to buyer.
        token::transfer(
            ctx.accounts.into_transfer_to_buyer_context().with_signer(&[&authority_seeds[..]]),
            amount,
        )?;
        // Update escrow_account
        ctx.accounts.escrow_account.amount -= amount;

        Ok(())
    }

    pub fn exchange(ctx: Context<Exchange>) -> ProgramResult {
        // Verify trial day.
        let clock: Clock = Clock::get().unwrap();
        // seconds in day: 24 * 60 * 60 = 86400
        if ctx.accounts.escrow_account.delivery_time + (i64::from(ctx.accounts.escrow_account.trial_day) * 86400) > clock.unix_timestamp {
            return Err(ErrorCode::InTrialDay.into())
        }

        // Make Seed
        let escrow_seed: String = format!("{}{}", "escrow-".to_string(), ctx.accounts.escrow_account.order_code.to_string());
        let escrow_pda_seed: &[u8] = escrow_seed.as_bytes();
        let (_vault_authority, vault_authority_bump) = Pubkey::find_program_address(&[escrow_pda_seed], ctx.program_id);
        let authority_seeds = &[&escrow_pda_seed[..], &[vault_authority_bump]];

        // Transfer token to seller.
        token::transfer(
            ctx.accounts.into_transfer_to_seller_context().with_signer(&[&authority_seeds[..]]),
            ctx.accounts.escrow_account.amount,
        )?;

        // Close vault account
        token::close_account(
            ctx.accounts.into_close_context().with_signer(&[&authority_seeds[..]]),
        )?;

        Ok(())
    }

    pub fn adjudge(ctx: Context<Adjudge>, order_code: u64, status: u8,) -> ProgramResult {
        // Judge can set status = (New or Shipping or Delivered).
        if ctx.accounts.escrow_account.order_code == order_code && (status == 0 || status == 1 || status == 2) {
            // Update escrow_account
            ctx.accounts.escrow_account.status = status;
            // If set status = Delivered, update delivery_time
            if status == 2 {
                let clock: Clock = Clock::get().unwrap();
                ctx.accounts.escrow_account.delivery_time = clock.unix_timestamp;
            }
        }

        Ok(())
    }

    pub fn adjudge_partial(ctx: Context<AdjudgePartial>, order_code: u64, amount: u64,) -> ProgramResult {
        // Make Seed
        let escrow_seed: String = format!("{}{}", "escrow-".to_string(), order_code.to_string());
        let escrow_pda_seed: &[u8] = escrow_seed.as_bytes();
        let (_vault_authority, vault_authority_bump) = Pubkey::find_program_address(&[escrow_pda_seed], ctx.program_id);
        let authority_seeds = &[&escrow_pda_seed[..], &[vault_authority_bump]];

        // Transfer token to buyer.
        token::transfer(
            ctx.accounts.into_transfer_to_buyer_context().with_signer(&[&authority_seeds[..]]),
            amount,
        )?;
        // Update escrow_account
        ctx.accounts.escrow_account.amount -= amount;

        Ok(())
    }

    pub fn adjudge_for_buyer(ctx: Context<AdjudgeForBuyer>, order_code: u64,) -> ProgramResult {
        // Make Seed
        let escrow_seed: String = format!("{}{}", "escrow-".to_string(), order_code.to_string());
        let escrow_pda_seed: &[u8] = escrow_seed.as_bytes();
        let (_vault_authority, vault_authority_bump) = Pubkey::find_program_address(&[escrow_pda_seed], ctx.program_id);
        let authority_seeds = &[&escrow_pda_seed[..], &[vault_authority_bump]];

        // Transfer token to buyer.
        token::transfer(
            ctx.accounts.into_transfer_to_buyer_context().with_signer(&[&authority_seeds[..]]),
            ctx.accounts.escrow_account.amount,
        )?;

        // Close vault account
        token::close_account(
            ctx.accounts.into_close_contest().with_signer(&[&authority_seeds[..]]),
        )?;

        Ok(())
    }

    pub fn adjudge_for_seller(ctx: Context<AdjudgeForSeller>, order_code: u64,) -> ProgramResult {
        // Make Seed
        let escrow_seed: String = format!("{}{}", "escrow-".to_string(), order_code.to_string());
        let escrow_pda_seed: &[u8] = escrow_seed.as_bytes();
        let (_vault_authority, vault_authority_bump) = Pubkey::find_program_address(&[escrow_pda_seed], ctx.program_id);
        let authority_seeds = &[&escrow_pda_seed[..], &[vault_authority_bump]];

        // Transfer token to seller.
        token::transfer(
            ctx.accounts.into_transfer_to_seller_context().with_signer(&[&authority_seeds[..]]),
            ctx.accounts.escrow_account.amount,
        )?;

        // Close vault account
        token::close_account(
            ctx.accounts.into_close_context().with_signer(&[&authority_seeds[..]]),
        )?;

        Ok(())
    }

    pub fn update_trial_day(ctx: Context<UpdateTrialDay>, order_code: u64, trial_day: u16,) -> ProgramResult {
        if ctx.accounts.escrow_account.order_code == order_code {
            // Update escrow_account trial_day
            ctx.accounts.escrow_account.trial_day = trial_day;
        }

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(vault_account_bump: u8, amount: u64, order_code: u64, trial_day: u16)]
pub struct Initialize<'info> {
    #[account(mut, signer)]
    pub buyer: AccountInfo<'info>,
    pub seller: AccountInfo<'info>,
    pub judge: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        seeds = [format!("{}{}", "token-seed-".to_string(), order_code.to_string()).as_bytes().as_ref()],
        bump = vault_account_bump,
        payer = buyer,
        token::mint = mint,
        token::authority = buyer,
        constraint = amount > 0,
    )]
    pub vault_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = buyer_deposit_token_account.amount >= amount
    )]
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(zero)]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    pub system_program: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64)]
pub struct Cancel<'info> {
    #[account(mut, signer)]
    pub buyer: AccountInfo<'info>,
    #[account(mut)]
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.order_code == order_code,
        constraint = escrow_account.status == 0,
        close = buyer
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64, amount: u64)]
pub struct CancelPartial<'info> {
    #[account(signer)]
    pub buyer: AccountInfo<'info>,
    #[account(mut)]
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    #[account(
        mut,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.order_code == order_code,
        constraint = escrow_account.status == 0,
        constraint = amount > 0,
        constraint = escrow_account.amount > amount,
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64, amount: u64)]
pub struct ChargeMore<'info> {
    #[account(mut, signer)]
    pub buyer: AccountInfo<'info>,
    #[account(mut, constraint = buyer_deposit_token_account.amount >= amount)]
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    pub seller: AccountInfo<'info>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.order_code == order_code,
        constraint = amount > 0
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64)]
pub struct Shipping<'info> {
    pub buyer: AccountInfo<'info>,
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    #[account(signer)]
    pub seller: AccountInfo<'info>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.order_code == order_code,
        constraint = escrow_account.status == 0
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64)]
pub struct Delivered<'info> {
    #[account(signer)]
    pub buyer: AccountInfo<'info>,
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    pub seller: AccountInfo<'info>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.order_code == order_code,
        constraint = escrow_account.status == 1
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64)]
pub struct Refund<'info> {
    pub buyer: AccountInfo<'info>,
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    #[account(signer)]
    pub seller: AccountInfo<'info>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.order_code == order_code,
        constraint = escrow_account.status > 0
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64, amount: u64)]
pub struct RefundPartial<'info> {
    pub buyer: AccountInfo<'info>,
    #[account(mut)]
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    #[account(signer)]
    pub seller: AccountInfo<'info>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.order_code == order_code,
        constraint = escrow_account.status > 0,
        constraint = amount > 0,
        constraint = escrow_account.amount > amount
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Exchange<'info> {
    #[account(mut)]
    pub buyer: AccountInfo<'info>,
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    #[account(signer)]
    pub seller: AccountInfo<'info>,
    #[account(mut)]
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.status == 2,
        close = buyer
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64, status: u8)]
pub struct Adjudge<'info> {
    #[account(signer)]
    pub judge: AccountInfo<'info>,
    pub buyer: AccountInfo<'info>,
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    pub seller: AccountInfo<'info>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.judge_key == *judge.key,
        constraint = escrow_account.order_code == order_code
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64, amount: u64)]
pub struct AdjudgePartial<'info> {
    #[account(signer)]
    pub judge: AccountInfo<'info>,
    pub buyer: AccountInfo<'info>,
    #[account(mut)]
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    pub seller: AccountInfo<'info>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.order_code == order_code,
        constraint = amount > 0,
        constraint = escrow_account.amount > amount
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64)]
pub struct AdjudgeForBuyer<'info> {
    #[account(signer)]
    pub judge: AccountInfo<'info>,
    #[account(mut)]
    pub buyer: AccountInfo<'info>,
    #[account(mut)]
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    pub seller: AccountInfo<'info>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.order_code == order_code,
        close = buyer
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64)]
pub struct AdjudgeForSeller<'info> {
    #[account(signer)]
    pub judge: AccountInfo<'info>,
    #[account(mut)]
    pub buyer: AccountInfo<'info>,
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    pub seller: AccountInfo<'info>,
    #[account(mut)]
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
        constraint = escrow_account.buyer_key == *buyer.key,
        constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
        constraint = escrow_account.seller_key == *seller.key,
        constraint = escrow_account.order_code == order_code,
        close = buyer
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    #[account(mut)]
    pub vault_account: Account<'info, TokenAccount>,
    pub vault_authority: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(order_code: u64, trial_day: u16)]
pub struct UpdateTrialDay<'info> {
    #[account(signer)]
    pub judge: AccountInfo<'info>,
    pub buyer: AccountInfo<'info>,
    pub buyer_deposit_token_account: Account<'info, TokenAccount>,
    pub seller: AccountInfo<'info>,
    pub seller_receive_token_account: Account<'info, TokenAccount>,
    #[account(
    mut,
    constraint = escrow_account.buyer_deposit_token_account == *buyer_deposit_token_account.to_account_info().key,
    constraint = escrow_account.buyer_key == *buyer.key,
    constraint = escrow_account.seller_receive_token_account == *seller_receive_token_account.to_account_info().key,
    constraint = escrow_account.seller_key == *seller.key,
    constraint = escrow_account.judge_key == *judge.key,
    constraint = escrow_account.order_code == order_code
    )]
    pub escrow_account: Box<Account<'info, EscrowAccount>>,
    pub token_program: AccountInfo<'info>,
}

#[account]
pub struct EscrowAccount {
    pub buyer_key: Pubkey,
    pub buyer_deposit_token_account: Pubkey,
    pub seller_key: Pubkey,
    pub seller_receive_token_account: Pubkey,
    pub judge_key: Pubkey,
    pub amount: u64,
    pub order_code: u64,
    /** status
        0: New
        1: Shipping
        2: Delivered
    */
    pub status: u8,
    pub delivery_time: i64,
    pub trial_day: u16,
}

#[error]
pub enum ErrorCode {
    #[msg("The order is still in the trial period.")]
    InTrialDay,
}

impl<'info> Initialize<'info> {
    fn into_transfer_to_pda_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.buyer_deposit_token_account.to_account_info().clone(),
            to: self.vault_account.to_account_info().clone(),
            authority: self.buyer.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }

    fn into_set_authority_context(&self) -> CpiContext<'_, '_, '_, 'info, SetAuthority<'info>> {
        let cpi_accounts = SetAuthority {
            account_or_mint: self.vault_account.to_account_info().clone(),
            current_authority: self.buyer.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> Cancel<'info> {
    fn into_transfer_to_buyer_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.vault_account.to_account_info().clone(),
            to: self.buyer_deposit_token_account.to_account_info().clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }

    fn into_close_contest(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        let cpi_accounts = CloseAccount {
            account: self.vault_account.to_account_info().clone(),
            destination: self.buyer.clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> CancelPartial<'info> {
    fn into_transfer_to_buyer_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.vault_account.to_account_info().clone(),
            to: self.buyer_deposit_token_account.to_account_info().clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> ChargeMore<'info> {
    fn into_transfer_to_pda_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.buyer_deposit_token_account.to_account_info().clone(),
            to: self.vault_account.to_account_info().clone(),
            authority: self.buyer.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> AdjudgePartial<'info> {
    fn into_transfer_to_buyer_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.vault_account.to_account_info().clone(),
            to: self.buyer_deposit_token_account.to_account_info().clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> AdjudgeForBuyer<'info> {
    fn into_transfer_to_buyer_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.vault_account.to_account_info().clone(),
            to: self.buyer_deposit_token_account.to_account_info().clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }

    fn into_close_contest(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        let cpi_accounts = CloseAccount {
            account: self.vault_account.to_account_info().clone(),
            destination: self.buyer.clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> AdjudgeForSeller<'info> {
    fn into_transfer_to_seller_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.vault_account.to_account_info().clone(),
            to: self.seller_receive_token_account.to_account_info().clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }

    fn into_close_context(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        let cpi_accounts = CloseAccount {
            account: self.vault_account.to_account_info().clone(),
            destination: self.buyer.clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> RefundPartial<'info> {
    fn into_transfer_to_buyer_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.vault_account.to_account_info().clone(),
            to: self.buyer_deposit_token_account.to_account_info().clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}

impl<'info> Exchange<'info> {
    fn into_transfer_to_seller_context(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        let cpi_accounts = Transfer {
            from: self.vault_account.to_account_info().clone(),
            to: self.seller_receive_token_account.to_account_info().clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }

    fn into_close_context(&self) -> CpiContext<'_, '_, '_, 'info, CloseAccount<'info>> {
        let cpi_accounts = CloseAccount {
            account: self.vault_account.to_account_info().clone(),
            destination: self.buyer.clone(),
            authority: self.vault_authority.clone(),
        };
        CpiContext::new(self.token_program.clone(), cpi_accounts)
    }
}
