const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Upgrade V1 to V2", function () {
  let tokenVault;
  let mockToken;
  let admin;
  let user1;
  let user2;
  
  const DEPOSIT_FEE = 500; // 5%
  const YIELD_RATE = 1000; // 10% annual

  beforeEach(async function () {
    [admin, user1, user2] = await ethers.getSigners();

    // Deploy MockERC20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy("Mock Token", "MTK");
    await mockToken.waitForDeployment();

    // Mint tokens to users and vault (for yield payments)
    await mockToken.mint(user1.address, ethers.parseEther("10000"));
    await mockToken.mint(user2.address, ethers.parseEther("10000"));
    await mockToken.mint(await tokenVault?.getAddress?.() || admin.address, ethers.parseEther("100000"));

    // Deploy TokenVaultV1
    const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
    tokenVault = await upgrades.deployProxy(
      TokenVaultV1,
      [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
      { initializer: "initialize", kind: "uups" }
    );
    await tokenVault.waitForDeployment();

    // Approve and make deposits in V1
    await mockToken.connect(user1).approve(await tokenVault.getAddress(), ethers.MaxUint256);
    await mockToken.connect(user2).approve(await tokenVault.getAddress(), ethers.MaxUint256);
    
    await tokenVault.connect(user1).deposit(ethers.parseEther("1000"));
    await tokenVault.connect(user2).deposit(ethers.parseEther("2000"));

    // Transfer tokens to vault for yield payments
    await mockToken.transfer(await tokenVault.getAddress(), ethers.parseEther("10000"));
  });

  describe("State Preservation", function () {
    it("should preserve user balances after upgrade", async function () {
      const user1BalanceBefore = await tokenVault.balanceOf(user1.address);
      const user2BalanceBefore = await tokenVault.balanceOf(user2.address);

      // Upgrade to V2
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      
      // Initialize V2 features
      await tokenVault.initializeV2();

      const user1BalanceAfter = await tokenVault.balanceOf(user1.address);
      const user2BalanceAfter = await tokenVault.balanceOf(user2.address);

      expect(user1BalanceAfter).to.equal(user1BalanceBefore);
      expect(user2BalanceAfter).to.equal(user2BalanceBefore);
    });

    it("should preserve total deposits after upgrade", async function () {
      const totalDepositsBefore = await tokenVault.totalDeposits();

      // Upgrade to V2
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await tokenVault.initializeV2();

      const totalDepositsAfter = await tokenVault.totalDeposits();

      expect(totalDepositsAfter).to.equal(totalDepositsBefore);
    });

    it("should maintain admin access control after upgrade", async function () {
      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));

      // Upgrade to V2
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await tokenVault.initializeV2();

      expect(await tokenVault.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await tokenVault.hasRole(UPGRADER_ROLE, admin.address)).to.be.true;
    });
  });

  describe("V2 New Features - Yield", function () {
    beforeEach(async function () {
      // Upgrade to V2
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await tokenVault.initializeV2();
    });

    it("should allow setting yield rate in V2", async function () {
      await tokenVault.connect(admin).setYieldRate(YIELD_RATE);
      expect(await tokenVault.getYieldRate()).to.equal(YIELD_RATE);
    });

    it("should calculate yield correctly", async function () {
      await tokenVault.connect(admin).setYieldRate(YIELD_RATE);
      
      // Make a small deposit to initialize lastClaimTime
      const depositTx = await tokenVault.connect(user1).deposit(ethers.parseEther("1"));
      await depositTx.wait();
      
      const balanceAfterDeposit = await tokenVault.balanceOf(user1.address);
      
      // Fast forward 365 days
      await time.increase(365 * 24 * 60 * 60);

      // Formula: (balance * yieldRate * timeElapsed) / (365 days * 10000)
      // After 1 year, yield should be approximately balance * yieldRate / 10000
      // YIELD_RATE = 1000 = 10%, so after 1 year: balance * 10%
      const actualYield = await tokenVault.getUserYield(user1.address);
      const expectedYieldApprox = (balanceAfterDeposit * BigInt(YIELD_RATE)) / BigInt(10000);
      
      // Verify yield is approximately 10% of balance (within 2%)
      expect(actualYield).to.be.greaterThan(expectedYieldApprox * BigInt(98) / BigInt(100));
      expect(actualYield).to.be.lessThan(expectedYieldApprox * BigInt(102) / BigInt(100));
    });

    it("should prevent non-admin from setting yield rate", async function () {
      await expect(
        tokenVault.connect(user1).setYieldRate(YIELD_RATE)
      ).to.be.reverted;
    });

    it("should allow claiming yield", async function () {
      await tokenVault.connect(admin).setYieldRate(YIELD_RATE);
      
      // Make a deposit to initialize lastClaimTime
      await tokenVault.connect(user1).deposit(ethers.parseEther("1"));
      
      // Fast forward time AFTER the deposit
      await time.increase(30 * 24 * 60 * 60); // 30 days

      const yieldBefore = await tokenVault.getUserYield(user1.address);
      expect(yieldBefore).to.be.greaterThan(0);

      await tokenVault.connect(user1).claimYield();

      const yieldAfter = await tokenVault.getUserYield(user1.address);
      expect(yieldAfter).to.equal(0);
    });
  });

  describe("V2 New Features - Pause", function () {
    beforeEach(async function () {
      // Upgrade to V2
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await tokenVault.initializeV2();
    });

    it("should allow pausing deposits in V2", async function () {
      expect(await tokenVault.isDepositsPaused()).to.be.false;
      
      await tokenVault.connect(admin).pauseDeposits();
      
      expect(await tokenVault.isDepositsPaused()).to.be.true;
    });

    it("should prevent deposits when paused", async function () {
      await tokenVault.connect(admin).pauseDeposits();
      
      await expect(
        tokenVault.connect(user1).deposit(ethers.parseEther("100"))
      ).to.be.revertedWith("Deposits are paused");
    });

    it("should allow unpausing deposits", async function () {
      await tokenVault.connect(admin).pauseDeposits();
      expect(await tokenVault.isDepositsPaused()).to.be.true;
      
      await tokenVault.connect(admin).unpauseDeposits();
      
      expect(await tokenVault.isDepositsPaused()).to.be.false;
      
      // Should be able to deposit again
      await tokenVault.connect(user1).deposit(ethers.parseEther("100"));
    });

    it("should prevent non-pauser from pausing", async function () {
      const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
      
      // Revoke pauser role from admin temporarily
      await tokenVault.connect(admin).revokeRole(PAUSER_ROLE, admin.address);
      
      await expect(
        tokenVault.connect(admin).pauseDeposits()
      ).to.be.reverted;
    });
  });

  describe("Version Check", function () {
    it("should return V2 version after upgrade", async function () {
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await tokenVault.initializeV2();

      expect(await tokenVault.getImplementationVersion()).to.equal("v2.0.0");
    });
  });

  describe("Backward Compatibility", function () {
    beforeEach(async function () {
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await tokenVault.initializeV2();
    });

    it("should still allow deposits after upgrade", async function () {
      const balanceBefore = await tokenVault.balanceOf(user1.address);
      await tokenVault.connect(user1).deposit(ethers.parseEther("100"));
      const balanceAfter = await tokenVault.balanceOf(user1.address);
      
      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it("should still allow withdrawals after upgrade", async function () {
      const balanceBefore = await tokenVault.balanceOf(user1.address);
      await tokenVault.connect(user1).withdraw(ethers.parseEther("100"));
      const balanceAfter = await tokenVault.balanceOf(user1.address);
      
      expect(balanceAfter).to.equal(balanceBefore - ethers.parseEther("100"));
    });
  });
});
