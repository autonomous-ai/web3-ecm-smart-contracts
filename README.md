# web3-ecm-smart-contracts
web3-ecm-smart-contracts is an Escrow smart contract on Solana blockchain platform.  

## Setup environment
### Install Rust
```bash
### Install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

### Upgrade
rustup update

### check
rustc --version
cargo --version
```

### Install Node >= 14.x.x

### Install Yarn
```bash
npm install -g yarn
```

### Install Solana Tool Suite
View docs solana [here](https://docs.solana.com/cli/install-solana-cli-tools).  
```bash
### Install
sh -c "$(curl -sSfL https://release.solana.com/v1.8.16/install)"

### Check
solana --version

### update
solana-install update
```

### Install Anchor
```bash
npm i -g @project-serum/anchor-cli
anchor --version
```

## Build escrow smart contract
```bash
### Install node module
cd web3-ecm-smart-contracts
npm install
or
yarn

### Build and Test smart contract
# Verify path to key pair and update if needed in Anchor.toml at [provider].wallet section
# Build smart contract
anchor build

# Run unit test
anchor test

# Get program id
anchor keys list
```
