// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TokenVaultV1
 * @dev UUPS upgradeable token vault with deposit/withdrawal functionality and fee mechanism
 */
contract TokenVaultV1 is 
    Initializable, 
    UUPSUpgradeable, 
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable 
{
    using SafeERC20 for IERC20;

    // Role definitions
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // State variables
    IERC20 public token;
    uint256 public depositFee; // Fee in basis points (e.g., 500 = 5%)
    
    mapping(address => uint256) private _balances;
    uint256 private _totalDeposits;

    // Storage gap for future upgrades
    uint256[50] private __gap;

    // Events
    event Deposited(address indexed user, uint256 amount, uint256 fee);
    event Withdrawn(address indexed user, uint256 amount);
    event DepositFeeUpdated(uint256 newFee);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev Initializes the contract with token, admin, and deposit fee
     * @param _token The ERC20 token address
     * @param _admin The admin address
     * @param _depositFee The deposit fee in basis points
     */
    function initialize(
        address _token, 
        address _admin, 
        uint256 _depositFee
    ) external initializer {
        require(_token != address(0), "Invalid token address");
        require(_admin != address(0), "Invalid admin address");
        require(_depositFee <= 10000, "Fee cannot exceed 100%");

        __UUPSUpgradeable_init();
        __AccessControl_init();
        __ReentrancyGuard_init();

        token = IERC20(_token);
        depositFee = _depositFee;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(UPGRADER_ROLE, _admin);
    }

    /**
     * @dev Deposits tokens into the vault
     * @param amount The amount to deposit
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be greater than 0");

        // Calculate fee
        uint256 fee = (amount * depositFee) / 10000;
        uint256 amountAfterFee = amount - fee;

        // Transfer tokens from user
        token.safeTransferFrom(msg.sender, address(this), amount);

        // Update balances
        _balances[msg.sender] += amountAfterFee;
        _totalDeposits += amountAfterFee;

        emit Deposited(msg.sender, amountAfterFee, fee);
    }

    /**
     * @dev Withdraws tokens from the vault
     * @param amount The amount to withdraw
     */
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be greater than 0");
        require(_balances[msg.sender] >= amount, "Insufficient balance");

        // Update balances
        _balances[msg.sender] -= amount;
        _totalDeposits -= amount;

        // Transfer tokens to user
        token.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @dev Returns the balance of a user
     * @param user The user address
     * @return The user's balance
     */
    function balanceOf(address user) external view returns (uint256) {
        return _balances[user];
    }

    /**
     * @dev Returns the total deposits in the vault
     * @return The total deposits
     */
    function totalDeposits() external view returns (uint256) {
        return _totalDeposits;
    }

    /**
     * @dev Returns the current deposit fee
     * @return The deposit fee in basis points
     */
    function getDepositFee() external view returns (uint256) {
        return depositFee;
    }

    /**
     * @dev Returns the implementation version
     * @return The version string
     */
    function getImplementationVersion() external pure returns (string memory) {
        return "v1.0.0";
    }

    /**
     * @dev Authorizes upgrade to new implementation
     * @param newImplementation The address of the new implementation
     */
    function _authorizeUpgrade(address newImplementation) 
        internal 
        override 
        onlyRole(UPGRADER_ROLE) 
    {}
}
