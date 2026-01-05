// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TokenVaultV3
 * @dev UUPS upgradeable token vault with withdrawal delays and emergency withdrawal
 */
contract TokenVaultV3 is 
    Initializable, 
    UUPSUpgradeable, 
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable 
{
    using SafeERC20 for IERC20;

    // Role definitions
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // State variables from V1
    IERC20 public token;
    uint256 public depositFee;
    
    mapping(address => uint256) private _balances;
    uint256 private _totalDeposits;

    // State variables from V2
    uint256 public yieldRate;
    mapping(address => uint256) private _lastClaimTime;
    bool public depositsPaused;

    // New state variables for V3
    uint256 public withdrawalDelay;
    
    struct WithdrawalRequest {
        uint256 amount;
        uint256 requestTime;
    }
    
    mapping(address => WithdrawalRequest) private _withdrawalRequests;

    // Reduced storage gap (47 - 2 = 45) to account for new variables (withdrawalDelay + mapping)
    uint256[45] private __gap;

    // Events
    event Deposited(address indexed user, uint256 amount, uint256 fee);
    event Withdrawn(address indexed user, uint256 amount);
    event DepositFeeUpdated(uint256 newFee);
    event YieldRateSet(uint256 newRate);
    event YieldClaimed(address indexed user, uint256 amount);
    event DepositsPaused();
    event DepositsUnpaused();
    event WithdrawalDelaySet(uint256 newDelay);
    event WithdrawalRequested(address indexed user, uint256 amount, uint256 requestTime);
    event WithdrawalExecuted(address indexed user, uint256 amount);
    event EmergencyWithdrawal(address indexed user, uint256 amount);

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
        _grantRole(PAUSER_ROLE, _admin);
    }

    /**
     * @dev Reinitializer for V2 upgrade
     */
    function initializeV2() external reinitializer(2) {
        // Grant PAUSER_ROLE to the admin for V2
        _grantRole(PAUSER_ROLE, msg.sender);
    }

    /**
     * @dev Reinitializer for V3 upgrade
     */
    function initializeV3() external reinitializer(3) {
        withdrawalDelay = 1 days; // Default delay
    }

    /**
     * @dev Deposits tokens into the vault
     * @param amount The amount to deposit
     */
    function deposit(uint256 amount) external nonReentrant {
        require(!depositsPaused, "Deposits are paused");
        require(amount > 0, "Amount must be greater than 0");

        // Calculate fee
        uint256 fee = (amount * depositFee) / 10000;
        uint256 amountAfterFee = amount - fee;

        // Transfer tokens from user
        token.safeTransferFrom(msg.sender, address(this), amount);

        // Initialize last claim time for new users or users who existed before V2
        if (_lastClaimTime[msg.sender] == 0) {
            _lastClaimTime[msg.sender] = block.timestamp;
        }

        // Update balances
        _balances[msg.sender] += amountAfterFee;
        _totalDeposits += amountAfterFee;

        emit Deposited(msg.sender, amountAfterFee, fee);
    }

    /**
     * @dev Withdraws tokens from the vault (kept for backward compatibility)
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
     * @dev Sets the withdrawal delay (admin only)
     * @param _delaySeconds The new delay in seconds
     */
    function setWithdrawalDelay(uint256 _delaySeconds) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_delaySeconds <= 30 days, "Delay too long");
        withdrawalDelay = _delaySeconds;
        emit WithdrawalDelaySet(_delaySeconds);
    }

    /**
     * @dev Returns the current withdrawal delay
     * @return The withdrawal delay in seconds
     */
    function getWithdrawalDelay() external view returns (uint256) {
        return withdrawalDelay;
    }

    /**
     * @dev Requests a withdrawal
     * @param amount The amount to withdraw
     */
    function requestWithdrawal(uint256 amount) external {
        require(amount > 0, "Amount must be greater than 0");
        require(_balances[msg.sender] >= amount, "Insufficient balance");

        // Cancel any previous pending request and create new one
        _withdrawalRequests[msg.sender] = WithdrawalRequest({
            amount: amount,
            requestTime: block.timestamp
        });

        emit WithdrawalRequested(msg.sender, amount, block.timestamp);
    }

    /**
     * @dev Executes a pending withdrawal after delay
     * @return The amount withdrawn
     */
    function executeWithdrawal() external nonReentrant returns (uint256) {
        WithdrawalRequest memory request = _withdrawalRequests[msg.sender];
        
        require(request.amount > 0, "No pending withdrawal");
        require(
            block.timestamp >= request.requestTime + withdrawalDelay,
            "Withdrawal delay not met"
        );
        require(_balances[msg.sender] >= request.amount, "Insufficient balance");

        uint256 amount = request.amount;

        // Clear withdrawal request
        delete _withdrawalRequests[msg.sender];

        // Update balances
        _balances[msg.sender] -= amount;
        _totalDeposits -= amount;

        // Transfer tokens to user
        token.safeTransfer(msg.sender, amount);

        emit WithdrawalExecuted(msg.sender, amount);
        return amount;
    }

    /**
     * @dev Emergency withdrawal bypassing delay
     * @return The amount withdrawn
     */
    function emergencyWithdraw() external nonReentrant returns (uint256) {
        uint256 balance = _balances[msg.sender];
        require(balance > 0, "No balance to withdraw");

        // Clear any pending withdrawal request
        delete _withdrawalRequests[msg.sender];

        // Update balances
        _balances[msg.sender] = 0;
        _totalDeposits -= balance;

        // Transfer tokens to user
        token.safeTransfer(msg.sender, balance);

        emit EmergencyWithdrawal(msg.sender, balance);
        return balance;
    }

    /**
     * @dev Returns the withdrawal request for a user
     * @param user The user address
     * @return amount The requested amount
     * @return requestTime The request timestamp
     */
    function getWithdrawalRequest(address user) 
        external 
        view 
        returns (uint256 amount, uint256 requestTime) 
    {
        WithdrawalRequest memory request = _withdrawalRequests[user];
        return (request.amount, request.requestTime);
    }

    /**
     * @dev Sets the yield rate (admin only)
     * @param _yieldRate The new yield rate in basis points
     */
    function setYieldRate(uint256 _yieldRate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_yieldRate <= 10000, "Yield rate cannot exceed 100%");
        yieldRate = _yieldRate;
        emit YieldRateSet(_yieldRate);
    }

    /**
     * @dev Returns the current yield rate
     * @return The yield rate in basis points
     */
    function getYieldRate() external view returns (uint256) {
        return yieldRate;
    }

    /**
     * @dev Claims accumulated yield for the caller
     * @return The amount of yield claimed
     */
    function claimYield() external nonReentrant returns (uint256) {
        // Initialize lastClaimTime if it's 0 (user from V1)
        if (_lastClaimTime[msg.sender] == 0) {
            _lastClaimTime[msg.sender] = block.timestamp;
            revert("No yield to claim");
        }

        uint256 yield = getUserYield(msg.sender);
        require(yield > 0, "No yield to claim");

        // Update last claim time
        _lastClaimTime[msg.sender] = block.timestamp;

        // Transfer yield to user
        token.safeTransfer(msg.sender, yield);

        emit YieldClaimed(msg.sender, yield);
        return yield;
    }

    /**
     * @dev Calculates the yield for a user
     * @param user The user address
     * @return The calculated yield
     */
    function getUserYield(address user) public view returns (uint256) {
        if (_balances[user] == 0 || yieldRate == 0) {
            return 0;
        }

        uint256 lastClaim = _lastClaimTime[user];
        // If lastClaimTime is 0 (user existed before V2), treat as no yield yet
        if (lastClaim == 0) {
            return 0;
        }

        uint256 timeElapsed = block.timestamp - lastClaim;
        uint256 yield = (_balances[user] * yieldRate * timeElapsed) / (365 days * 10000);
        
        return yield;
    }

    /**
     * @dev Pauses deposits
     */
    function pauseDeposits() external onlyRole(PAUSER_ROLE) {
        require(!depositsPaused, "Deposits already paused");
        depositsPaused = true;
        emit DepositsPaused();
    }

    /**
     * @dev Unpauses deposits
     */
    function unpauseDeposits() external onlyRole(PAUSER_ROLE) {
        require(depositsPaused, "Deposits not paused");
        depositsPaused = false;
        emit DepositsUnpaused();
    }

    /**
     * @dev Returns whether deposits are paused
     * @return True if deposits are paused
     */
    function isDepositsPaused() external view returns (bool) {
        return depositsPaused;
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
        return "v3.0.0";
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
