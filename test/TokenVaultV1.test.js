const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("TokenVaultV1", function () {
  let tokenVault;
  let mockToken;
  let admin;
  let user1;
  let user2;
  
  const DEPOSIT_FEE = 500; // 5%
  const INITIAL_SUPPLY = ethers.parseEther("1000000");

  beforeEach(async function () {
    [admin, user1, user2] = await ethers.getSigners();

    // Deploy MockERC20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy("Mock Token", "MTK");
    await mockToken.waitForDeployment();

    // Mint tokens to users
    await mockToken.mint(user1.address, ethers.parseEther("10000"));
    await mockToken.mint(user2.address, ethers.parseEther("10000"));

    // Deploy TokenVaultV1 as upgradeable proxy
    const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
    tokenVault = await upgrades.deployProxy(
      TokenVaultV1,
      [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
      { initializer: "initialize", kind: "uups" }
    );
    await tokenVault.waitForDeployment();

    // Approve vault to spend user tokens
    await mockToken.connect(user1).approve(await tokenVault.getAddress(), ethers.MaxUint256);
    await mockToken.connect(user2).approve(await tokenVault.getAddress(), ethers.MaxUint256);
  });

  describe("Initialization", function () {
    it("should initialize with correct parameters", async function () {
      expect(await tokenVault.token()).to.equal(await mockToken.getAddress());
      expect(await tokenVault.getDepositFee()).to.equal(DEPOSIT_FEE);
      expect(await tokenVault.totalDeposits()).to.equal(0);
      
      // Check admin role
      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      expect(await tokenVault.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should prevent reinitialization", async function () {
      await expect(
        tokenVault.initialize(await mockToken.getAddress(), admin.address, DEPOSIT_FEE)
      ).to.be.revertedWithCustomError(tokenVault, "InvalidInitialization");
    });
  });

  describe("Deposits", function () {
    it("should allow deposits and update balances", async function () {
      const depositAmount = ethers.parseEther("1000");
      const expectedBalance = ethers.parseEther("950"); // After 5% fee

      await tokenVault.connect(user1).deposit(depositAmount);

      expect(await tokenVault.balanceOf(user1.address)).to.equal(expectedBalance);
      expect(await tokenVault.totalDeposits()).to.equal(expectedBalance);
    });

    it("should deduct deposit fee correctly", async function () {
      const depositAmount = ethers.parseEther("1000");
      const fee = (depositAmount * BigInt(DEPOSIT_FEE)) / BigInt(10000);
      const expectedBalance = depositAmount - fee;

      const balanceBefore = await mockToken.balanceOf(user1.address);
      await tokenVault.connect(user1).deposit(depositAmount);
      const balanceAfter = await mockToken.balanceOf(user1.address);

      expect(balanceBefore - balanceAfter).to.equal(depositAmount);
      expect(await tokenVault.balanceOf(user1.address)).to.equal(expectedBalance);
    });

    it("should handle multiple deposits", async function () {
      const deposit1 = ethers.parseEther("1000");
      const deposit2 = ethers.parseEther("500");
      
      await tokenVault.connect(user1).deposit(deposit1);
      await tokenVault.connect(user1).deposit(deposit2);

      const expectedBalance1 = ethers.parseEther("950"); // 1000 - 5%
      const expectedBalance2 = ethers.parseEther("475"); // 500 - 5%
      const totalExpected = expectedBalance1 + expectedBalance2;

      expect(await tokenVault.balanceOf(user1.address)).to.equal(totalExpected);
    });

    it("should revert on zero deposit", async function () {
      await expect(
        tokenVault.connect(user1).deposit(0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });
  });

  describe("Withdrawals", function () {
    beforeEach(async function () {
      const depositAmount = ethers.parseEther("1000");
      await tokenVault.connect(user1).deposit(depositAmount);
    });

    it("should allow withdrawals and update balances", async function () {
      const withdrawAmount = ethers.parseEther("500");
      const balanceBefore = await tokenVault.balanceOf(user1.address);

      await tokenVault.connect(user1).withdraw(withdrawAmount);

      expect(await tokenVault.balanceOf(user1.address)).to.equal(balanceBefore - withdrawAmount);
    });

    it("should prevent withdrawal of more than balance", async function () {
      const balance = await tokenVault.balanceOf(user1.address);
      const excessAmount = balance + ethers.parseEther("1");

      await expect(
        tokenVault.connect(user1).withdraw(excessAmount)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("should transfer tokens correctly on withdrawal", async function () {
      const withdrawAmount = ethers.parseEther("500");
      const tokenBalanceBefore = await mockToken.balanceOf(user1.address);

      await tokenVault.connect(user1).withdraw(withdrawAmount);

      const tokenBalanceAfter = await mockToken.balanceOf(user1.address);
      expect(tokenBalanceAfter - tokenBalanceBefore).to.equal(withdrawAmount);
    });

    it("should revert on zero withdrawal", async function () {
      await expect(
        tokenVault.connect(user1).withdraw(0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });
  });

  describe("Version", function () {
    it("should return correct version", async function () {
      expect(await tokenVault.getImplementationVersion()).to.equal("v1.0.0");
    });
  });

  describe("Access Control", function () {
    it("should grant admin role on initialization", async function () {
      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      expect(await tokenVault.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should grant upgrader role on initialization", async function () {
      const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));
      expect(await tokenVault.hasRole(UPGRADER_ROLE, admin.address)).to.be.true;
    });
  });
});
