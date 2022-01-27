# web3-ecm-smart-contracts
web3-ecm-smart-contracts is an escrow smart contract on Solana blockchain.  

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
sh -c "$(curl -sSfL https://release.solana.com/v1.9.1/install)"

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
# Anchor build
anchor build

# Anchor test
anchor test

# Get program id
anchor keys list
```
