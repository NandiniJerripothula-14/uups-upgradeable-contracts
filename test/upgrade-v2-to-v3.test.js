const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Upgrade V2 to V3", function () {
  let tokenVault;
  let mockToken;
  let admin;
  let user1;
  let user2;
  
  const DEPOSIT_FEE = 500; // 5%
  const YIELD_RATE = 1000; // 10% annual
  const WITHDRAWAL_DELAY = 2 * 24 * 60 * 60; // 2 days

  beforeEach(async function () {
    [admin, user1, user2] = await ethers.getSigners();

    // Deploy MockERC20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy("Mock Token", "MTK");
    await mockToken.waitForDeployment();

    // Mint tokens
    await mockToken.mint(user1.address, ethers.parseEther("10000"));
    await mockToken.mint(user2.address, ethers.parseEther("10000"));

    // Deploy V1
    const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
    tokenVault = await upgrades.deployProxy(
      TokenVaultV1,
      [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
      { initializer: "initialize", kind: "uups" }
    );
    await tokenVault.waitForDeployment();

    // Setup approvals and deposits
    await mockToken.connect(user1).approve(await tokenVault.getAddress(), ethers.MaxUint256);
    await mockToken.connect(user2).approve(await tokenVault.getAddress(), ethers.MaxUint256);
    
    await tokenVault.connect(user1).deposit(ethers.parseEther("1000"));
    await tokenVault.connect(user2).deposit(ethers.parseEther("2000"));

    // Transfer tokens to vault for yield
    await mockToken.transfer(await tokenVault.getAddress(), ethers.parseEther("10000"));

    // Upgrade to V2
    const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
    tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
    await tokenVault.initializeV2();
    
    // Set yield rate in V2
    await tokenVault.connect(admin).setYieldRate(YIELD_RATE);
  });

  describe("State Preservation", function () {
    it("should preserve all V2 state after upgrade", async function () {
      const user1BalanceBefore = await tokenVault.balanceOf(user1.address);
      const user2BalanceBefore = await tokenVault.balanceOf(user2.address);
      const totalDepositsBefore = await tokenVault.totalDeposits();
      const yieldRateBefore = await tokenVault.getYieldRate();
      const depositsPausedBefore = await tokenVault.isDepositsPaused();

      // Upgrade to V3
      const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV3);
      await tokenVault.initializeV3();

      expect(await tokenVault.balanceOf(user1.address)).to.equal(user1BalanceBefore);
      expect(await tokenVault.balanceOf(user2.address)).to.equal(user2BalanceBefore);
      expect(await tokenVault.totalDeposits()).to.equal(totalDepositsBefore);
      expect(await tokenVault.getYieldRate()).to.equal(yieldRateBefore);
      expect(await tokenVault.isDepositsPaused()).to.equal(depositsPausedBefore);
    });
  });

  describe("V3 New Features - Withdrawal Delay", function () {
    beforeEach(async function () {
      // Upgrade to V3
      const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV3);
      await tokenVault.initializeV3();
    });

    it("should allow setting withdrawal delay", async function () {
      await tokenVault.connect(admin).setWithdrawalDelay(WITHDRAWAL_DELAY);
      expect(await tokenVault.getWithdrawalDelay()).to.equal(WITHDRAWAL_DELAY);
    });

    it("should handle withdrawal requests correctly", async function () {
      const withdrawAmount = ethers.parseEther("100");
      
      await tokenVault.connect(user1).requestWithdrawal(withdrawAmount);
      
      const [amount, requestTime] = await tokenVault.getWithdrawalRequest(user1.address);
      expect(amount).to.equal(withdrawAmount);
      expect(requestTime).to.be.greaterThan(0);
    });

    it("should enforce withdrawal delay", async function () {
      await tokenVault.connect(admin).setWithdrawalDelay(WITHDRAWAL_DELAY);
      
      const withdrawAmount = ethers.parseEther("100");
      await tokenVault.connect(user1).requestWithdrawal(withdrawAmount);
      
      // Try to execute immediately
      await expect(
        tokenVault.connect(user1).executeWithdrawal()
      ).to.be.revertedWith("Withdrawal delay not met");
    });

    it("should allow withdrawal after delay period", async function () {
      await tokenVault.connect(admin).setWithdrawalDelay(WITHDRAWAL_DELAY);
      
      const withdrawAmount = ethers.parseEther("100");
      const balanceBefore = await tokenVault.balanceOf(user1.address);
      
      await tokenVault.connect(user1).requestWithdrawal(withdrawAmount);
      
      // Fast forward past delay
      await time.increase(WITHDRAWAL_DELAY + 1);
      
      await tokenVault.connect(user1).executeWithdrawal();
      
      const balanceAfter = await tokenVault.balanceOf(user1.address);
      expect(balanceAfter).to.equal(balanceBefore - withdrawAmount);
    });

    it("should prevent premature withdrawal execution", async function () {
      await tokenVault.connect(admin).setWithdrawalDelay(WITHDRAWAL_DELAY);
      
      await tokenVault.connect(user1).requestWithdrawal(ethers.parseEther("100"));
      
      // Fast forward but not enough
      await time.increase(WITHDRAWAL_DELAY - 100);
      
      await expect(
        tokenVault.connect(user1).executeWithdrawal()
      ).to.be.revertedWith("Withdrawal delay not met");
    });

    it("should replace previous withdrawal request with new one", async function () {
      await tokenVault.connect(user1).requestWithdrawal(ethers.parseEther("100"));
      await tokenVault.connect(user1).requestWithdrawal(ethers.parseEther("200"));
      
      const [amount] = await tokenVault.getWithdrawalRequest(user1.address);
      expect(amount).to.equal(ethers.parseEther("200"));
    });
  });

  describe("V3 New Features - Emergency Withdrawal", function () {
    beforeEach(async function () {
      const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV3);
      await tokenVault.initializeV3();
      await tokenVault.connect(admin).setWithdrawalDelay(WITHDRAWAL_DELAY);
    });

    it("should allow emergency withdrawals", async function () {
      const balanceBefore = await tokenVault.balanceOf(user1.address);
      const tokenBalanceBefore = await mockToken.balanceOf(user1.address);
      
      await tokenVault.connect(user1).emergencyWithdraw();
      
      expect(await tokenVault.balanceOf(user1.address)).to.equal(0);
      expect(await mockToken.balanceOf(user1.address)).to.equal(tokenBalanceBefore + balanceBefore);
    });

    it("should bypass withdrawal delay for emergency withdrawals", async function () {
      // Request normal withdrawal first
      await tokenVault.connect(user1).requestWithdrawal(ethers.parseEther("100"));
      
      // Immediately do emergency withdrawal without waiting
      const balanceBefore = await tokenVault.balanceOf(user1.address);
      await tokenVault.connect(user1).emergencyWithdraw();
      
      expect(await tokenVault.balanceOf(user1.address)).to.equal(0);
    });

    it("should clear pending withdrawal request after emergency withdrawal", async function () {
      await tokenVault.connect(user1).requestWithdrawal(ethers.parseEther("100"));
      await tokenVault.connect(user1).emergencyWithdraw();
      
      const [amount] = await tokenVault.getWithdrawalRequest(user1.address);
      expect(amount).to.equal(0);
    });
  });

  describe("Version Check", function () {
    it("should return V3 version after upgrade", async function () {
      const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV3);
      await tokenVault.initializeV3();

      expect(await tokenVault.getImplementationVersion()).to.equal("v3.0.0");
    });
  });

  describe("Backward Compatibility", function () {
    beforeEach(async function () {
      const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV3);
      await tokenVault.initializeV3();
    });

    it("should still support V1 deposit functionality", async function () {
      const balanceBefore = await tokenVault.balanceOf(user1.address);
      await tokenVault.connect(user1).deposit(ethers.parseEther("100"));
      
      expect(await tokenVault.balanceOf(user1.address)).to.be.greaterThan(balanceBefore);
    });

    it("should still support V1 withdraw functionality", async function () {
      const balanceBefore = await tokenVault.balanceOf(user1.address);
      await tokenVault.connect(user1).withdraw(ethers.parseEther("100"));
      
      expect(await tokenVault.balanceOf(user1.address)).to.equal(balanceBefore - ethers.parseEther("100"));
    });

    it("should still support V2 yield functionality", async function () {
      // Make a deposit to initialize lastClaimTime
      await tokenVault.connect(user1).deposit(ethers.parseEther("1"));
      
      // Wait AFTER deposit for yield to accrue
      await time.increase(30 * 24 * 60 * 60); // 30 days
      
      const yield = await tokenVault.getUserYield(user1.address);
      expect(yield).to.be.greaterThan(0);
      
      await tokenVault.connect(user1).claimYield();
    });

    it("should still support V2 pause functionality", async function () {
      await tokenVault.connect(admin).pauseDeposits();
      expect(await tokenVault.isDepositsPaused()).to.be.true;
      
      await tokenVault.connect(admin).unpauseDeposits();
      expect(await tokenVault.isDepositsPaused()).to.be.false;
    });
  });
});
