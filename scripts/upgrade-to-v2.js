const { ethers, upgrades } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Upgrading TokenVault to V2 with account:", deployer.address);

  // Load deployment info
  const fs = require("fs");
  let proxyAddress;
  
  try {
    const deploymentInfo = JSON.parse(fs.readFileSync("deployment-v1.json", "utf8"));
    proxyAddress = deploymentInfo.proxy;
    console.log("Found existing proxy at:", proxyAddress);
  } catch (error) {
    console.error("Error: deployment-v1.json not found. Please deploy V1 first.");
    process.exit(1);
  }

  // Get contract factory
  const TokenVaultV2 = await ethers.getContractFactory("TokenVaultV2");

  console.log("\nUpgrading to TokenVaultV2...");
  const tokenVault = await upgrades.upgradeProxy(proxyAddress, TokenVaultV2);
  await tokenVault.waitForDeployment();

  console.log("Proxy address (unchanged):", await tokenVault.getAddress());
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(
    await tokenVault.getAddress()
  );
  console.log("New implementation deployed to:", implementationAddress);

  // Initialize V2 features
  console.log("\nInitializing V2 features...");
  const tx = await tokenVault.initializeV2();
  await tx.wait();
  console.log("V2 initialization complete");

  // Verify upgrade
  console.log("\nVerifying upgrade...");
  console.log("Version:", await tokenVault.getImplementationVersion());
  console.log("Yield Rate:", await tokenVault.getYieldRate());
  console.log("Deposits Paused:", await tokenVault.isDepositsPaused());

  // Check that old state is preserved
  console.log("\nChecking state preservation...");
  console.log("Token:", await tokenVault.token());
  console.log("Deposit Fee:", await tokenVault.getDepositFee());
  console.log("Total Deposits:", await tokenVault.totalDeposits());

  // Save upgrade info
  const upgradeInfo = {
    network: network.name,
    proxy: await tokenVault.getAddress(),
    implementation: implementationAddress,
    version: "v2.0.0",
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(
    "deployment-v2.json",
    JSON.stringify(upgradeInfo, null, 2)
  );
  console.log("\nUpgrade info saved to deployment-v2.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
