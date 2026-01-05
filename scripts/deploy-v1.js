const { ethers, upgrades } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying TokenVaultV1 with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Get contract factories
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const TokenVaultV1 = await ethers.getContractFactory("TokenVaultV1");

  // Deploy Mock Token
  console.log("\nDeploying MockERC20...");
  const mockToken = await MockERC20.deploy("Mock Token", "MTK");
  await mockToken.waitForDeployment();
  console.log("MockERC20 deployed to:", await mockToken.getAddress());

  // Deploy TokenVaultV1 as upgradeable proxy
  console.log("\nDeploying TokenVaultV1 (UUPS Proxy)...");
  const depositFee = 500; // 5%
  
  const tokenVault = await upgrades.deployProxy(
    TokenVaultV1,
    [await mockToken.getAddress(), deployer.address, depositFee],
    {
      initializer: "initialize",
      kind: "uups"
    }
  );
  await tokenVault.waitForDeployment();

  console.log("TokenVaultV1 Proxy deployed to:", await tokenVault.getAddress());
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(
    await tokenVault.getAddress()
  );
  console.log("TokenVaultV1 Implementation deployed to:", implementationAddress);

  // Verify deployment
  console.log("\nVerifying deployment...");
  console.log("Token:", await tokenVault.token());
  console.log("Deposit Fee:", await tokenVault.getDepositFee());
  console.log("Version:", await tokenVault.getImplementationVersion());

  // Save deployment info
  const fs = require("fs");
  const deploymentInfo = {
    network: network.name,
    mockToken: await mockToken.getAddress(),
    proxy: await tokenVault.getAddress(),
    implementation: implementationAddress,
    admin: deployer.address,
    depositFee: depositFee,
    version: "v1.0.0",
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(
    "deployment-v1.json",
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("\nDeployment info saved to deployment-v1.json");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
