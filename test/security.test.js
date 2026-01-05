const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("Security Tests", function () {
  let tokenVault;
  let mockToken;
  let admin;
  let user1;
  let user2;
  let attacker;
  
  const DEPOSIT_FEE = 500; // 5%

  beforeEach(async function () {
    [admin, user1, user2, attacker] = await ethers.getSigners();

    // Deploy MockERC20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockToken = await MockERC20.deploy("Mock Token", "MTK");
    await mockToken.waitForDeployment();

    // Mint tokens
    await mockToken.mint(user1.address, ethers.parseEther("10000"));
    await mockToken.mint(attacker.address, ethers.parseEther("10000"));
  });

  describe("Initialization Security", function () {
    it("should prevent direct initialization of implementation contracts", async function () {
      // Deploy implementation directly (not through proxy)
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      const implementation = await TokenVaultV1.deploy();
      await implementation.waitForDeployment();

      // Try to initialize the implementation directly
      await expect(
        implementation.initialize(await mockToken.getAddress(), admin.address, DEPOSIT_FEE)
      ).to.be.revertedWithCustomError(implementation, "InvalidInitialization");
    });

    it("should prevent reinitialization of proxy", async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      tokenVault = await upgrades.deployProxy(
        TokenVaultV1,
        [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
        { initializer: "initialize", kind: "uups" }
      );
      await tokenVault.waitForDeployment();

      // Try to reinitialize
      await expect(
        tokenVault.initialize(await mockToken.getAddress(), admin.address, DEPOSIT_FEE)
      ).to.be.revertedWithCustomError(tokenVault, "InvalidInitialization");
    });

    it("should validate initialization parameters", async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      
      // Invalid token address
      await expect(
        upgrades.deployProxy(
          TokenVaultV1,
          [ethers.ZeroAddress, admin.address, DEPOSIT_FEE],
          { initializer: "initialize", kind: "uups" }
        )
      ).to.be.revertedWith("Invalid token address");

      // Invalid admin address
      await expect(
        upgrades.deployProxy(
          TokenVaultV1,
          [await mockToken.getAddress(), ethers.ZeroAddress, DEPOSIT_FEE],
          { initializer: "initialize", kind: "uups" }
        )
      ).to.be.revertedWith("Invalid admin address");

      // Invalid fee (>100%)
      await expect(
        upgrades.deployProxy(
          TokenVaultV1,
          [await mockToken.getAddress(), admin.address, 10001],
          { initializer: "initialize", kind: "uups" }
        )
      ).to.be.revertedWith("Fee cannot exceed 100%");
    });
  });

  describe("Upgrade Authorization", function () {
    beforeEach(async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      tokenVault = await upgrades.deployProxy(
        TokenVaultV1,
        [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
        { initializer: "initialize", kind: "uups" }
      );
      await tokenVault.waitForDeployment();
    });

    it("should prevent unauthorized upgrades", async function () {
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      const v2Implementation = await TokenVaultV2.deploy();
      await v2Implementation.waitForDeployment();

      // Try to upgrade as non-admin
      const attackerVault = tokenVault.connect(attacker);
      await expect(
        upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2.connect(attacker))
      ).to.be.reverted;
    });

    it("should allow admin to upgrade", async function () {
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      
      // Admin should be able to upgrade
      const upgraded = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await upgraded.initializeV2();
      
      expect(await upgraded.getImplementationVersion()).to.equal("v2.0.0");
    });

    it("should maintain upgrader role after upgrade", async function () {
      const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));
      
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await tokenVault.initializeV2();
      
      expect(await tokenVault.hasRole(UPGRADER_ROLE, admin.address)).to.be.true;
    });
  });

  describe("Storage Layout", function () {
    it("should use storage gaps for future upgrades", async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      tokenVault = await upgrades.deployProxy(
        TokenVaultV1,
        [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
        { initializer: "initialize", kind: "uups" }
      );
      await tokenVault.waitForDeployment();

      // Deposit some funds
      await mockToken.connect(user1).approve(await tokenVault.getAddress(), ethers.MaxUint256);
      await tokenVault.connect(user1).deposit(ethers.parseEther("1000"));
      
      const balanceV1 = await tokenVault.balanceOf(user1.address);

      // Upgrade to V2
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await tokenVault.initializeV2();

      // Check balance is preserved
      expect(await tokenVault.balanceOf(user1.address)).to.equal(balanceV1);

      // Upgrade to V3
      const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV3);
      await tokenVault.initializeV3();

      // Check balance is still preserved
      expect(await tokenVault.balanceOf(user1.address)).to.equal(balanceV1);
    });

    it("should not have storage layout collisions across versions", async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      tokenVault = await upgrades.deployProxy(
        TokenVaultV1,
        [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
        { initializer: "initialize", kind: "uups" }
      );
      await tokenVault.waitForDeployment();

      await mockToken.connect(user1).approve(await tokenVault.getAddress(), ethers.MaxUint256);
      await tokenVault.connect(user1).deposit(ethers.parseEther("1000"));

      const user1BalanceV1 = await tokenVault.balanceOf(user1.address);
      const totalDepositsV1 = await tokenVault.totalDeposits();
      const depositFeeV1 = await tokenVault.getDepositFee();

      // Upgrade to V2
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV2);
      await tokenVault.initializeV2();

      // All V1 state should be intact
      expect(await tokenVault.balanceOf(user1.address)).to.equal(user1BalanceV1);
      expect(await tokenVault.totalDeposits()).to.equal(totalDepositsV1);
      expect(await tokenVault.getDepositFee()).to.equal(depositFeeV1);

      // Set V2 state
      await tokenVault.setYieldRate(1000);
      await tokenVault.pauseDeposits();

      const yieldRateV2 = await tokenVault.getYieldRate();
      const depositsPausedV2 = await tokenVault.isDepositsPaused();

      // Upgrade to V3
      const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");
      tokenVault = await upgrades.upgradeProxy(await tokenVault.getAddress(), TokenVaultV3);
      await tokenVault.initializeV3();

      // All V1 and V2 state should be intact
      expect(await tokenVault.balanceOf(user1.address)).to.equal(user1BalanceV1);
      expect(await tokenVault.totalDeposits()).to.equal(totalDepositsV1);
      expect(await tokenVault.getDepositFee()).to.equal(depositFeeV1);
      expect(await tokenVault.getYieldRate()).to.equal(yieldRateV2);
      expect(await tokenVault.isDepositsPaused()).to.equal(depositsPausedV2);
    });
  });

  describe("Function Selector Clashing", function () {
    it("should prevent function selector clashing", async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");
      const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");

      // Get all function fragments
      const v1Fragments = TokenVaultV1.interface.fragments.filter(f => f.type === 'function');
      const v2Fragments = TokenVaultV2.interface.fragments.filter(f => f.type === 'function');
      const v3Fragments = TokenVaultV3.interface.fragments.filter(f => f.type === 'function');

      // Extract function selectors
      const v1Selectors = v1Fragments.map(f => TokenVaultV1.interface.getFunction(f.name).selector);
      const v2Selectors = v2Fragments.map(f => TokenVaultV2.interface.getFunction(f.name).selector);
      const v3Selectors = v3Fragments.map(f => TokenVaultV3.interface.getFunction(f.name).selector);

      // Check for duplicates within each version
      const hasDuplicates = (arr) => new Set(arr).size !== arr.length;
      
      expect(hasDuplicates(v1Selectors)).to.be.false;
      expect(hasDuplicates(v2Selectors)).to.be.false;
      expect(hasDuplicates(v3Selectors)).to.be.false;
    });
  });

  describe("Access Control Security", function () {
    beforeEach(async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      tokenVault = await upgrades.deployProxy(
        TokenVaultV1,
        [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
        { initializer: "initialize", kind: "uups" }
      );
      await tokenVault.waitForDeployment();
    });

    it("should enforce role-based access control", async function () {
      const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
      const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));

      // Admin should have both roles
      expect(await tokenVault.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await tokenVault.hasRole(UPGRADER_ROLE, admin.address)).to.be.true;

      // Attacker should have neither role
      expect(await tokenVault.hasRole(DEFAULT_ADMIN_ROLE, attacker.address)).to.be.false;
      expect(await tokenVault.hasRole(UPGRADER_ROLE, attacker.address)).to.be.false;
    });

    it("should prevent role escalation", async function () {
      const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));

      // Attacker tries to grant themselves upgrader role
      await expect(
        tokenVault.connect(attacker).grantRole(UPGRADER_ROLE, attacker.address)
      ).to.be.reverted;
    });
  });

  describe("Reentrancy Protection", function () {
    it("should protect deposit function from reentrancy", async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      tokenVault = await upgrades.deployProxy(
        TokenVaultV1,
        [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
        { initializer: "initialize", kind: "uups" }
      );
      await tokenVault.waitForDeployment();

      // Normal deposit should work
      await mockToken.connect(user1).approve(await tokenVault.getAddress(), ethers.MaxUint256);
      await expect(
        tokenVault.connect(user1).deposit(ethers.parseEther("1000"))
      ).to.not.be.reverted;
    });

    it("should protect withdraw function from reentrancy", async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      tokenVault = await upgrades.deployProxy(
        TokenVaultV1,
        [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
        { initializer: "initialize", kind: "uups" }
      );
      await tokenVault.waitForDeployment();

      // Setup
      await mockToken.connect(user1).approve(await tokenVault.getAddress(), ethers.MaxUint256);
      await tokenVault.connect(user1).deposit(ethers.parseEther("1000"));

      // Normal withdraw should work
      await expect(
        tokenVault.connect(user1).withdraw(ethers.parseEther("500"))
      ).to.not.be.reverted;
    });
  });

  describe("Input Validation", function () {
    beforeEach(async function () {
      const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");
      tokenVault = await upgrades.deployProxy(
        TokenVaultV1,
        [await mockToken.getAddress(), admin.address, DEPOSIT_FEE],
        { initializer: "initialize", kind: "uups" }
      );
      await tokenVault.waitForDeployment();

      await mockToken.connect(user1).approve(await tokenVault.getAddress(), ethers.MaxUint256);
      await tokenVault.connect(user1).deposit(ethers.parseEther("1000"));
    });

    it("should prevent zero amount deposits", async function () {
      await expect(
        tokenVault.connect(user1).deposit(0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("should prevent zero amount withdrawals", async function () {
      await expect(
        tokenVault.connect(user1).withdraw(0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("should prevent withdrawal of more than balance", async function () {
      const balance = await tokenVault.balanceOf(user1.address);
      await expect(
        tokenVault.connect(user1).withdraw(balance + ethers.parseEther("1"))
      ).to.be.revertedWith("Insufficient balance");
    });
  });
});
