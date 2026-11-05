/**
 * Explicit deployment of the 0.5 A423Escrow reference contract.
 * Nothing is broadcast unless A423_DEPLOY_CONFIRM=I_UNDERSTAND is set.
 *
 *   A423_DEPLOY_CONFIRM=I_UNDERSTAND npx tsx scripts/deploy-a423-escrow.ts
 *
 * The contract takes one immutable token address. This script does not deploy
 * a token and does not update .env.
 */
import 'dotenv/config';
import { ContractFactory, JsonRpcProvider, Wallet } from 'ethers';
import { ESCROW_ABI, ESCROW_BYTECODE } from '@allorc/a423-sdk/escrow';
import { getSignerPrivateKey } from '../lib/chain/config';

async function main() {
  const rpc = process.env.RPC_URL;
  const chainId = Number(process.env.CHAIN_ID ?? NaN);
  const token = process.env.A423_TOKEN_ADDRESS || process.env.MOCK_WIF_ADDRESS;
  const signerIndex = Number(process.env.A423_DEPLOYER_SIGNER_INDEX ?? 2);
  if (!rpc || !Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('RPC_URL/CHAIN_ID are required');
  if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error('A423_TOKEN_ADDRESS (or MOCK_WIF_ADDRESS) is required');
  if (!Number.isSafeInteger(signerIndex) || signerIndex < 0) throw new Error('A423_DEPLOYER_SIGNER_INDEX is invalid');

  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const wallet = new Wallet(getSignerPrivateKey(signerIndex), provider);

  console.log(`network:  ${chainId} (${rpc})`);
  console.log(`token:    ${token}`);
  console.log(`deployer: ${wallet.address}`);
  if (process.env.A423_DEPLOY_CONFIRM !== 'I_UNDERSTAND') {
    console.log('\nDry run only. This would deploy A423Escrow with the token above.');
    console.log('Set A423_DEPLOY_CONFIRM=I_UNDERSTAND to broadcast the deployment transaction.');
    return;
  }

  const factory = new ContractFactory(ESCROW_ABI, ESCROW_BYTECODE, wallet);
  const contract = await factory.deploy(token);
  const tx = contract.deploymentTransaction();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`\nA423Escrow deployed: ${address}`);
  if (tx) console.log(`deployment tx:      ${tx.hash}`);
  console.log(`\nSet A423_ESCROW_ADDRESS=${address} and A423_ESCROW_VERSION=0.5 in .env.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
