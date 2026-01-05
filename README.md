# UUPS Upgradeable Token Vault [![Coverage](https://img.shields.io/badge/Coverage-81%25-brightgreen)](coverage/index.html)

A production-grade upgradeable smart contract system implementing a TokenVault protocol using the UUPS (Universal Upgradeable Proxy Standard) pattern. This project demonstrates best practices for upgradeable smart contracts including storage layout management, access control, secure initialization, and cross-version state migration.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Usage](#usage)
- [Testing](#testing)
- [Deployment](#deployment)
- [Storage Layout Strategy](#storage-layout-strategy)
- [Access Control Design](#access-control-design)
- [Security Considerations](#security-considerations)
- [Known Limitations](#known-limitations)
- [Contract Versions](#contract-versions)

## Overview

This project implements a TokenVault system that evolves through three versions:

- **V1**: Basic deposit/withdrawal functionality with configurable fees
- **V2**: Adds yield generation and deposit pause controls
- **V3**: Implements withdrawal delays and emergency withdrawal mechanisms

Each version maintains backward compatibility while introducing new features, demonstrating real-world upgrade patterns used in production DeFi protocols.

## Features

### Version 1 (V1)
- ERC20 token deposits with configurable fee mechanism
- Withdrawal functionality
- User balance tracking
- Role-based access control (Admin, Upgrader)
- UUPS proxy pattern for upgradeability

### Version 2 (V2)
- All V1 features
- Time-based yield generation (annual percentage in basis points)
- Yield claiming mechanism
- Deposit pause/unpause functionality
- Additional PAUSER_ROLE for granular access control

### Version 3 (V3)
- All V1 and V2 features
- Withdrawal delay mechanism for enhanced security
- Withdrawal request/execute pattern
- Emergency withdrawal (bypasses delay)
- Configurable delay periods

## Architecture

The system uses OpenZeppelin's UUPS (Universal Upgradeable Proxy Standard) pattern, which provides:

- Gas-efficient upgrades
- Upgrade authorization in implementation contract
- Smaller proxy contract size
- Better alignment with the principle of least privilege

```
┌─────────────────┐
│  Proxy Contract │ ← User interacts here (address never changes)
└────────┬────────┘
         │ delegatecall
         ▼
┌─────────────────────┐
│ Implementation (V1) │ ← Can be upgraded to V2, V3, etc.
└─────────────────────┘
```

## Installation

### Prerequisites

- Node.js >= 16.0.0
- npm or yarn

### Setup

```bash
# Clone the repository
git clone <your-repo-url>
cd uups-upgradeable-contracts

# Install dependencies
npm install

# Compile contracts
npx hardhat compile
```

## Usage

### Compiling Contracts

```bash
npm run compile
# or
npx hardhat compile
```

### Running Tests

```bash
# Run all tests
npm test
# or
npx hardhat test

# Run with gas reporting
REPORT_GAS=true npx hardhat test

# Run coverage
npm run test:coverage
# or
npx hardhat coverage

Latest coverage (Hardhat):
- Statements: 81.12%
- Branches: 48.59%
- Functions: 90.38%
- Lines: 81.32%
```

## Testing

The project includes comprehensive test suites covering:

### TokenVaultV1.test.js
- Initialization with correct parameters
- Deposit functionality and fee calculation
- Withdrawal functionality and balance updates
- Reinitialization protection
- Access control verification

### upgrade-v1-to-v2.test.js
- State preservation during upgrade
- V2 yield rate configuration
- Yield calculation and claiming
- Deposit pause/unpause functionality
- Backward compatibility with V1 functions

### upgrade-v2-to-v3.test.js
- State preservation from V2 to V3
- Withdrawal delay configuration
- Withdrawal request/execute pattern
- Emergency withdrawal functionality
- Backward compatibility with V1 and V2 functions

### security.test.js
- Direct initialization prevention
- Unauthorized upgrade protection
- Storage layout collision prevention
- Function selector uniqueness
- Reentrancy protection
- Access control enforcement
- Input validation

## Deployment

### Deploy V1

```bash
npm run deploy:v1
# or
npx hardhat run scripts/deploy-v1.js --network <network-name>
```

This will:
1. Deploy a MockERC20 token (for testing)
2. Deploy TokenVaultV1 implementation
3. Deploy UUPS proxy
4. Initialize the proxy with V1 implementation
5. Save deployment info to `deployment-v1.json`

### Upgrade to V2

```bash
npm run upgrade:v2
# or
npx hardhat run scripts/upgrade-to-v2.js --network <network-name>
```

This will:
1. Load existing proxy address from `deployment-v1.json`
2. Deploy TokenVaultV2 implementation
3. Upgrade proxy to V2
4. Initialize V2-specific features
5. Save upgrade info to `deployment-v2.json`

### Upgrade to V3

```bash
npm run upgrade:v3
# or
npx hardhat run scripts/upgrade-to-v3.js --network <network-name>
```

This will:
1. Load existing proxy address
2. Deploy TokenVaultV3 implementation
3. Upgrade proxy to V3
4. Initialize V3-specific features
5. Save upgrade info to `deployment-v3.json`

## Storage Layout Strategy

### Principles

1. **Never reorder, remove, or change the type of existing state variables**
2. **Always append new state variables**
3. **Maintain storage gaps** to reserve slots for future upgrades
4. **Reduce gap size** when adding new variables

### Storage Layout

#### V1 Storage Layout
```solidity
IERC20 public token;                        // Slot 0
uint256 public depositFee;                  // Slot 1
mapping(address => uint256) private _balances; // Slot 2
uint256 private _totalDeposits;             // Slot 3
uint256[50] private __gap;                  // Slots 4-53 (reserved)
```

#### V2 Storage Layout (Additions)
```solidity
// ... all V1 variables (unchanged)
uint256 public yieldRate;                          // Slot 4 (from gap)
mapping(address => uint256) private _lastClaimTime; // Slot 5 (from gap)
bool public depositsPaused;                        // Slot 6 (from gap)
uint256[47] private __gap;                         // Slots 7-53 (reduced by 3)
```

#### V3 Storage Layout (Additions)
```solidity
// ... all V1 and V2 variables (unchanged)
uint256 public withdrawalDelay;                              // Slot 7 (from gap)
mapping(address => WithdrawalRequest) private _withdrawalRequests; // Slot 8 (from gap)
// WithdrawalRequest struct uses 2 slots (amount, requestTime)
uint256[44] private __gap;                                   // Slots 9-53 (reduced by 3)
```

### Why Storage Gaps?

Storage gaps reserve space for future upgrades without risking storage collisions. When adding new variables:
- New variables consume slots from the gap
- Gap size is reduced accordingly
- Total storage layout size remains constant
- No collision with future contract storage

## Access Control Design

### Role Hierarchy

```
DEFAULT_ADMIN_ROLE (0x00)
├── Can grant/revoke any role
├── Can set yield rates
├── Can set withdrawal delays
└── Typically held by a multisig or governance contract

UPGRADER_ROLE
├── Can authorize upgrades
├── Should be separate from admin for security
└── Granted to admin by default (can be changed)

PAUSER_ROLE (V2+)
├── Can pause/unpause deposits
├── Should be held by security monitoring systems
└── Granted to admin by default (can be changed)
```

### Security Benefits

1. **Separation of Concerns**: Different roles for different operations
2. **Compromise Resistance**: Single compromised key doesn't control everything
3. **Operational Flexibility**: Can grant roles to different actors (EOA, multisig, contracts)
4. **Revocability**: Roles can be revoked if a key is compromised

### Recommendations for Production

- **DEFAULT_ADMIN_ROLE**: Timelock contract or multisig (3-of-5 or higher)
- **UPGRADER_ROLE**: Separate multisig dedicated to upgrades
- **PAUSER_ROLE**: Automated monitoring system + manual override multisig

## Security Considerations

### Implemented Protections

1. **Initialization Security**
   - `_disableInitializers()` in constructor prevents direct initialization of implementation
   - `initializer` modifier prevents reinitialization of proxy
   - `reinitializer` with version numbers for upgrade initializations

2. **Upgrade Authorization**
   - `_authorizeUpgrade` requires UPGRADER_ROLE
   - Cannot be bypassed through delegatecall or other means

3. **Reentrancy Protection**
   - ReentrancyGuard on all state-changing functions
   - Uses OpenZeppelin's audited implementation

4. **Access Control**
   - Role-based permissions for sensitive operations
   - Principle of least privilege

5. **Input Validation**
   - Zero amount checks
   - Balance sufficiency checks
   - Address validation on initialization
   - Fee and rate limit checks

6. **Storage Layout**
   - Carefully managed to prevent collisions
   - Storage gaps for future flexibility

### Audit Recommendations

Before production deployment:
- [ ] Professional smart contract audit
- [ ] Formal verification of critical functions
- [ ] Gas optimization review
- [ ] Integration testing with actual tokens
- [ ] Stress testing with high transaction volumes
- [ ] Upgrade procedure testing on testnet
- [ ] Documentation review

## Known Limitations

### Design Decisions and Trade-offs

1. **Yield Payment Source**
   - Current implementation requires vault to have sufficient token balance for yield payments
   - Production version should implement a dedicated yield reserve or external funding mechanism

2. **Fee Collection**
   - Fees are currently kept in the vault contract
   - Production version should implement fee withdrawal for protocol treasury

3. **Withdrawal Delay**
   - Emergency withdrawal bypasses delay without restrictions
   - Production version might want additional guards (e.g., only in emergency state)

4. **Yield Calculation**
   - Yield doesn't compound automatically
   - Users must claim yield separately
   - Could be gas-inefficient for users with frequent deposits/withdrawals

5. **Single Token Support**
   - Each vault instance supports only one token
   - Multi-token support would require significant architecture changes

6. **Gas Costs**
   - Storage operations are not heavily optimized
   - Priority given to security and correctness over gas efficiency

### Future Enhancements

- Multi-token vault support
- Automatic yield compounding
- Graduated withdrawal delays based on amount
- Fee distribution mechanism
- Emergency state management
- Batch operations for gas efficiency
- Integration with price oracles for yield calculation
- Time-weighted average balance for yield calculation

## Contract Versions

### V1.0.0
- Initial implementation
- Basic deposit/withdrawal
- Fee mechanism
- Access control
- UUPS upgradeability

### V2.0.0
- Yield generation system
- Deposit pause functionality
- PAUSER_ROLE addition
- Backward compatible with V1

### V3.0.0
- Withdrawal delay mechanism
- Emergency withdrawal
- Request/execute withdrawal pattern
- Backward compatible with V1 and V2

## License

MIT

## Contributing

Contributions are welcome! Please ensure:
- All tests pass
- Code follows existing style
- New features include tests
- Documentation is updated

## Contact

For questions or issues, please open a GitHub issue.

---

**⚠️ Disclaimer**: This code is provided for educational purposes. It has not been audited. Do not use in production without a professional security audit.
