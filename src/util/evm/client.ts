import {
  Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  HttpTransport,
  LocalAccount,
  PublicClient,
  WalletClient,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { IS_TESTNET } from '../../constant';
import {
  LIKER_NFT_PRIVATE_KEY,
} from '../../../config/secret';
import config from '../../../config/config';

let client: PublicClient<HttpTransport, Chain, undefined>;
let walletClient: WalletClient<HttpTransport, Chain, LocalAccount>;

const baseFeeMultiplier = config.EVM_BASE_FEE_MULTIPLIER || 3;

const baseWithFee = defineChain({
  ...base,
  fees: {
    baseFeeMultiplier,
  },
});

const baseSepoliaWithFee = defineChain({
  ...baseSepolia,
  fees: {
    baseFeeMultiplier,
  },
});

// Base chain (with the shared fee multiplier) for the active network, reused by any
// wallet client on Base regardless of which key signs.
export const evmChain = IS_TESTNET ? baseSepoliaWithFee : baseWithFee;

export function getEVMClient(): PublicClient<HttpTransport, Chain, undefined> {
  if (!client) {
    const rpcUrl = config.EVM_RPC_ENDPOINT_OVERRIDE || undefined;
    client = createPublicClient({
      chain: evmChain,
      transport: http(rpcUrl),
    }) as PublicClient<HttpTransport, Chain, undefined>;
  }
  return client;
}

// Build a Base wallet client for any signing account (shared chain + RPC transport).
export function createEVMWalletClient(
  account: LocalAccount,
): WalletClient<HttpTransport, Chain, LocalAccount> {
  return createWalletClient({
    account,
    chain: evmChain,
    transport: http(config.EVM_RPC_ENDPOINT_OVERRIDE || undefined),
  });
}

export function getEVMWalletAccount(): LocalAccount {
  const evmHex = LIKER_NFT_PRIVATE_KEY.toString('hex');
  const account = privateKeyToAccount(`0x${evmHex}`);
  return account;
}

export function getEVMWalletClient(): WalletClient<HttpTransport, Chain, LocalAccount> {
  if (!walletClient) {
    walletClient = createEVMWalletClient(getEVMWalletAccount());
  }
  return walletClient;
}

export default getEVMClient;
