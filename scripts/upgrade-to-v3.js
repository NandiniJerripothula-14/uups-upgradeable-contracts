const { ethers, upgrades } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Upgrading TokenVault to V3 with account:", deployer.address);

  // Load deployment info
  const fs = require("fs");
  let proxyAddress;
  
  try {
    // Try V2 deployment first, fallback to V1
    try {
      const deploymentInfo = JSON.parse(fs.readFileSync("deployment-v2.json", "utf8"));
      proxyAddress = deploymentInfo.proxy;
    } catch {
      const deploymentInfo = JSON.parse(fs.readFileSync("deployment-v1.json", "utf8"));
      proxyAddress = deploymentInfo.proxy;
    }
    console.log("Found existing proxy at:", proxyAddress);
  } catch (error) {
    console.error("Error: deployment info not found. Please deploy V1/V2 first.");
    process.exit(1);
  }

  // Get contract factory
  const TokenVaultV3 = await ethers.getContractFactory("TokenVaultV3");

  console.log("\nUpgrading to TokenVaultV3...");
  const tokenVault = await upgrades.upgradeProxy(proxyAddress, TokenVaultV3);
  await tokenVault.waitForDeployment();

  console.log("Proxy address (unchanged):", await tokenVault.getAddress());
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(
    await tokenVault.getAddress()
  );
  console.log("New implementation deployed to:", implementationAddress);

  // Initialize V3 features
  console.log("\nInitializing V3 features...");
  const tx = await tokenVault.initializeV3();
  await tx.wait();
  console.log("V3 initialization complete");

  // Verify upgrade
  console.log("\nVerifying upgrade...");
  console.log("Version:", await tokenVault.getImplementationVersion());
  console.log("Withdrawal Delay:", await tokenVault.getWithdrawalDelay());

  // Check that old state is preserved
  console.log("\nChecking state preservation...");
  console.log("Token:", await tokenVault.token());
  console.log("Deposit Fee:", await tokenVault.getDepositFee());
  console.log("Total Deposits:", await tokenVault.totalDeposits());
  console.log("Yield Rate:", await tokenVault.getYieldRate());
  console.log("Deposits Paused:", await tokenVault.isDepositsPaused());

  // Save upgrade info
  const upgradeInfo = {
    network: network.name,
    proxy: await tokenVault.getAddress(),
    implementation: implementationAddress,
    version: "v3.0.0",
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(
    "deployment-v3.json",
    JSON.stringify(upgradeInfo, null, 2)
  );
  console.log("\nUpgrade info saved to deployment-v3.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
