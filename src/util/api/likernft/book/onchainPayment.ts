import crypto from 'crypto';
import uuidv4 from 'uuid/v4';
import {
  erc20Abi,
  getAddress,
  verifyTypedData,
  type Address,
  type Hex,
} from 'viem';

import { ValidationError } from '../../../ValidationError';
import {
  IS_TESTNET,
  BOOK3_HOSTNAME,
  PUBSUB_TOPIC_MISC,
} from '../../../../constant';
import {
  FieldValue,
  likeNFTBookCartCollection,
  likeNFTBookUserCollection,
} from '../../../firebase';
import publisher from '../../../gcloudPub';
import { isValidEVMAddress } from '../../../evm';
import { getEVMWalletAccount, getEVMWalletClient } from '../../../evm/client';
import { isEVMClassId } from '../../../evm/nft';
import { sendWriteContractWithNonce } from '../../../evm/tx';
import {
  getBookUserInfo,
  getBookUserInfoFromLikerId,
  getBookUserInfoFromLegacyString,
} from './user';
import { checkIsFromLikerLand, calculateItemPrices, calculateTotalFeeInfo } from './price';
import {
  createNewNFTBookCartPayment,
  processNFTBookCartPurchase,
  claimNFTBookCart,
  formatCartItemsWithInfo,
} from './cart';
import type {
  CartItem, CartItemWithInfo, ItemPriceInfo, TransactionFeeInfo,
} from './type';
import {
  USDC_CONTRACT_ADDRESS,
  X402_PAYMENT_ENABLED,
  X402_PAYMENT_RECEIVER_ADDRESS,
  NFT_BOOK_LIKER_LAND_ART_EVM_WALLET,
} from '../../../../../config/config';

// USDC is EIP-3009 enabled (transferWithAuthorization). A buyer signs an
// authorization off-chain; any relayer — here, our own platform wallet — can
// submit it on-chain, so the x402 pilot needs no external facilitator.
// name/version are the EIP-712 domain fields of each network's USDC contract;
// they must match exactly or signature verification fails.
const USDC_NETWORKS = {
  mainnet: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    network: 'base',
  },
  testnet: {
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
    name: 'USDC',
    version: '2',
    chainId: 84532,
    network: 'base-sepolia',
  },
};

// USDC has 6 decimals; book prices are USD cents (USD * 100). USDC atomic =
// USD * 1e6 = cents * 1e4. Stablecoin, so the USD→USDC rate is treated as 1:1.
const USDC_DECIMAL_MULTIPLIER = 10000n;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// FiatTokenV2_2 (Base USDC) exposes a bytes-signature overload, so we can pass
// the raw signature instead of splitting it into v/r/s.
const USDC_TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const X402_VERSION = 1;
const X402_AUTHORIZATION_TIMEOUT_SECONDS = 600;

function getUSDCNetwork() {
  return IS_TESTNET ? USDC_NETWORKS.testnet : USDC_NETWORKS.mainnet;
}

export function getUSDCContractAddress(): Address {
  return getAddress(USDC_CONTRACT_ADDRESS || getUSDCNetwork().address);
}

export function getX402ReceiverAddress(): Address {
  return getAddress(X402_PAYMENT_RECEIVER_ADDRESS || getEVMWalletAccount().address);
}

export function convertUSDCentsToUSDCAtomic(cents: number): bigint {
  return BigInt(Math.round(cents)) * USDC_DECIMAL_MULTIPLIER;
}

export interface X402PaymentPayload {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  signature: Hex;
}

export interface X402PaymentRequirements {
  scheme: 'exact';
  network: string;
  asset: Address;
  payTo: Address;
  maxAmountRequired: string;
  resource: string;
  description: string;
  nonce: Hex;
  validAfter: string;
  validBefore: string;
  extra: { name: string; version: string };
}

// Build the EIP-3009 authorization the buyer must sign. The server dictates the
// full authorization (amount, recipient, nonce, expiry) so the signed payload
// is bound to this exact quote and the USDC nonce gives single-use replay
// protection on-chain.
export function getX402Requirements({
  priceInDecimal,
  description,
}: {
  priceInDecimal: number;
  description: string;
}): X402PaymentRequirements {
  const usdc = getUSDCNetwork();
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const validBefore = nowInSeconds + X402_AUTHORIZATION_TIMEOUT_SECONDS;
  const nonce = `0x${crypto.randomBytes(32).toString('hex')}` as Hex;
  return {
    scheme: 'exact',
    network: usdc.network,
    asset: getUSDCContractAddress(),
    payTo: getX402ReceiverAddress(),
    maxAmountRequired: convertUSDCentsToUSDCAtomic(priceInDecimal).toString(),
    resource: `https://${BOOK3_HOSTNAME}/api/likernft/book/purchase/x402`,
    description,
    nonce,
    validAfter: '0',
    validBefore: validBefore.toString(),
    extra: { name: usdc.name, version: usdc.version },
  };
}

async function verifyX402Authorization(
  payment: X402PaymentPayload,
  requirements: X402PaymentRequirements,
) {
  const usdc = getUSDCNetwork();
  const payTo = getX402ReceiverAddress();
  if (getAddress(payment.to) !== payTo) {
    throw new ValidationError('X402_INVALID_RECIPIENT', 400);
  }
  if (getAddress(payment.from) === payTo) {
    throw new ValidationError('X402_INVALID_PAYER', 400);
  }
  // The payload must match the nonce/expiry we issued, else a buyer could swap
  // in a looser authorization than the quote we priced.
  if (payment.nonce !== requirements.nonce) {
    throw new ValidationError('X402_NONCE_MISMATCH', 400);
  }
  if (BigInt(payment.value) < BigInt(requirements.maxAmountRequired)) {
    throw new ValidationError('X402_INSUFFICIENT_AMOUNT', 400);
  }
  const nowInSeconds = Math.floor(Date.now() / 1000);
  if (BigInt(payment.validBefore) <= BigInt(nowInSeconds)) {
    throw new ValidationError('X402_AUTHORIZATION_EXPIRED', 400);
  }
  if (BigInt(payment.validAfter) > BigInt(nowInSeconds)) {
    throw new ValidationError('X402_AUTHORIZATION_NOT_YET_VALID', 400);
  }
  const isValid = await verifyTypedData({
    address: getAddress(payment.from),
    domain: {
      name: usdc.name,
      version: usdc.version,
      chainId: usdc.chainId,
      verifyingContract: getUSDCContractAddress(),
    },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(payment.from),
      to: getAddress(payment.to),
      value: BigInt(payment.value),
      validAfter: BigInt(payment.validAfter),
      validBefore: BigInt(payment.validBefore),
      nonce: payment.nonce,
    },
    signature: payment.signature,
  });
  if (!isValid) {
    throw new ValidationError('X402_INVALID_SIGNATURE', 400);
  }
}

// Submit the buyer's signed authorization, pulling USDC buyer → platform
// wallet. Idempotent against the quote doc: a prior settlement short-circuits,
// and the USDC nonce makes a replayed authorization revert on-chain anyway.
export async function verifyAndSettleX402Payment(
  payment: X402PaymentPayload,
  requirements: X402PaymentRequirements,
): Promise<string> {
  await verifyX402Authorization(payment, requirements);

  const account = getEVMWalletAccount();
  const walletClient = getEVMWalletClient();
  const res = await sendWriteContractWithNonce(walletClient, {
    chain: walletClient.chain,
    address: getUSDCContractAddress(),
    abi: USDC_TRANSFER_WITH_AUTHORIZATION_ABI,
    account,
    functionName: 'transferWithAuthorization',
    args: [
      getAddress(payment.from),
      getAddress(payment.to),
      BigInt(payment.value),
      BigInt(payment.validAfter),
      BigInt(payment.validBefore),
      payment.nonce,
      payment.signature,
    ],
  });
  return res.transactionHash;
}

export async function transferUSDC(to: string, atomicAmount: bigint): Promise<string> {
  const account = getEVMWalletAccount();
  const walletClient = getEVMWalletClient();
  const res = await sendWriteContractWithNonce(walletClient, {
    chain: walletClient.chain,
    address: getUSDCContractAddress(),
    abi: erc20Abi,
    account,
    functionName: 'transfer',
    args: [getAddress(to), atomicAmount],
  });
  return res.transactionHash;
}

// Pay a single recipient in USDC, recording a deterministic ledger entry so a
// retried settlement never double-pays. On-chain has no idempotency key, so the
// ledger doc id (paymentId + classId + priceIndex + type + wallet) stands in for
// Stripe's idempotencyKey.
type TransferType = 'channelCommission' | 'connectedWallet' | 'artFee';

async function transferRoyaltyOnChain({
  type,
  wallet,
  amount,
  ownerWallet,
  classId,
  priceIndex,
  paymentId,
  amountTotal,
  buyerEmail,
}: {
  type: TransferType;
  wallet: string;
  amount: number;
  ownerWallet: string;
  classId: string;
  priceIndex: number;
  paymentId: string;
  amountTotal: number;
  buyerEmail: string | null;
}) {
  if (amount <= 0) return null;
  if (!isValidEVMAddress(wallet)) return null;
  const ledgerId = `${paymentId}-${classId}-${priceIndex}-${type}-${wallet}`;
  const ledgerRef = likeNFTBookUserCollection.doc(wallet).collection('commissions').doc(ledgerId);
  const existing = await ledgerRef.get();
  if (existing.exists && existing.data()?.status === 'completed') {
    return existing.data()?.txHash || null;
  }
  await ledgerRef.set({
    type,
    ownerWallet,
    classId,
    priceIndex,
    paymentId,
    amountTotal,
    amount,
    currency: 'usdc',
    status: 'pending',
    ...(buyerEmail ? { buyerEmail } : {}),
    timestamp: FieldValue.serverTimestamp(),
  }, { merge: true });
  const txHash = await transferUSDC(wallet, convertUSDCentsToUSDCAtomic(amount));
  await ledgerRef.set({ status: 'completed', txHash }, { merge: true });
  return txHash;
}

// On-chain mirror of handleStripeConnectedAccount: the platform wallet (which
// just received the buyer's USDC) splits royalties to author EVM wallets. No
// Stripe Connect readiness gate — the EVM wallet is the payout identity, so any
// valid address is payable.
export async function handleConnectedAccountOnChain({
  classId = '',
  priceIndex = -1,
  paymentId,
  ownerWallet,
  buyerEmail,
}: {
  classId?: string;
  priceIndex?: number;
  paymentId: string;
  ownerWallet: string;
  buyerEmail: string | null;
}, {
  amountTotal,
  likerLandArtFee = 0,
  channelCommission = 0,
  royaltyToSplit = 0,
}: {
  amountTotal: number;
  likerLandArtFee?: number;
  channelCommission?: number;
  royaltyToSplit?: number;
}, { connectedWallets: connectedWalletsInput, from }) {
  const transfers: { type: TransferType; wallet: string; amount: number; txHash: string }[] = [];
  if (!amountTotal) return { transfers };

  let connectedWallets = connectedWalletsInput;
  if (!connectedWallets) {
    connectedWallets = { [ownerWallet]: 1 };
  }

  async function settle(type: TransferType, wallet: string, amount: number) {
    const txHash = await transferRoyaltyOnChain({
      type, wallet, amount, ownerWallet, classId, priceIndex, paymentId, amountTotal, buyerEmail,
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error(`Failed on-chain ${type} for ${wallet}`);
      // eslint-disable-next-line no-console
      console.error(e);
      return null;
    });
    if (txHash) {
      transfers.push({
        type, wallet, amount, txHash,
      });
    }
  }

  if (channelCommission) {
    let fromWallet: string | undefined;
    if (from && !checkIsFromLikerLand(from)) {
      let fromUser: any = null;
      if (from.startsWith('@')) {
        fromUser = await getBookUserInfoFromLikerId(from.substring(1, from.length));
      }
      if (!fromUser) {
        fromUser = await getBookUserInfoFromLegacyString(from);
      }
      if (fromUser?.wallet) fromWallet = fromUser.wallet;
    }
    if (fromWallet) await settle('channelCommission', fromWallet, channelCommission);
  }

  if (royaltyToSplit > 0 && connectedWallets && Object.keys(connectedWallets).length) {
    const wallets = Object.keys(connectedWallets).filter((w) => isValidEVMAddress(w));
    const totalSplit = wallets.reduce((acc, w) => acc + connectedWallets[w], 0);
    if (totalSplit > 0) {
      for (const wallet of wallets) {
        // Floored share can round to 0 (tiny weight / sub-cent split); skip
        // rather than fire a doomed transfer, mirroring the Stripe path.
        const amountSplit = Math.floor((royaltyToSplit * connectedWallets[wallet]) / totalSplit);
        if (amountSplit > 0) await settle('connectedWallet', wallet, amountSplit);
      }
    }
  }

  if (likerLandArtFee && NFT_BOOK_LIKER_LAND_ART_EVM_WALLET) {
    await settle('artFee', NFT_BOOK_LIKER_LAND_ART_EVM_WALLET, likerLandArtFee);
  }

  return { transfers };
}

// Lean on-chain counterpart of processNFTBookCart: reuse the payment-agnostic
// status/stock core, then pay authors in USDC and auto-claim. Stripe-specific
// concerns (paymentIntent, Airtable, promo emails) are intentionally omitted
// for the pilot.
export async function processNFTBookCartOnChain(
  {
    itemInfos,
    itemPrices,
    totalFeeInfo,
    coupon = '',
  }: {
    itemInfos: CartItemWithInfo[];
    itemPrices: ItemPriceInfo[];
    totalFeeInfo: TransactionFeeInfo;
    coupon?: string;
  },
  {
    cartId,
    paymentId,
    claimToken,
    evmWallet,
    from,
    ipCountry,
    settleTxHash,
  }: {
    cartId: string;
    paymentId: string;
    claimToken: string;
    evmWallet?: string;
    from?: string;
    ipCountry?: string;
    settleTxHash?: string;
  },
  { email }: { email: string | null },
  req: any,
) {
  await createNewNFTBookCartPayment(cartId, paymentId, {
    type: 'x402',
    claimToken,
    from,
    itemInfos,
    itemPrices,
    feeInfo: totalFeeInfo,
    coupon,
    ipCountry,
  });

  try {
    const { classInfos } = await processNFTBookCartPurchase({ cartId, email, paymentId });

    for (let itemIndex = 0; itemIndex < classInfos.length; itemIndex += 1) {
      const { classId, listingData, txData } = classInfos[itemIndex];
      const { connectedWallets, ownerWallet } = listingData;
      const {
        price,
        priceIndex,
        priceName,
        quantity,
        feeInfo,
        from: itemFrom,
      } = txData;
      const {
        priceInDecimal,
        channelCommission,
        likerLandArtFee,
        royaltyToSplit,
      } = feeInfo as TransactionFeeInfo;

      await handleConnectedAccountOnChain(
        {
          classId,
          priceIndex,
          paymentId,
          ownerWallet,
          buyerEmail: email,
        },
        {
          amountTotal: priceInDecimal,
          channelCommission,
          likerLandArtFee,
          royaltyToSplit,
        },
        { connectedWallets, from: itemFrom },
      );

      publisher.publish(PUBSUB_TOPIC_MISC, req, {
        logType: 'BookNFTPurchaseComplete',
        type: 'x402',
        paymentId,
        classId,
        priceName,
        priceIndex,
        price,
        quantity,
        email,
        fromChannel: from,
        settleTxHash,
      });
    }

    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'BookNFTPurchaseCaptured',
      type: 'x402',
      paymentId,
      cartId,
      email,
      price: totalFeeInfo.priceInDecimal / 100,
      numberOfItems: classInfos.length,
      settleTxHash,
    });

    // Auto-claim immediately — an x402 buyer always has a connected wallet.
    if (evmWallet) {
      const { allItemsAutoClaimed } = await claimNFTBookCart(
        cartId,
        {
          message: '', wallet: evmWallet, token: claimToken, loginMethod: 'autoClaim',
        },
        req,
      );
      publisher.publish(PUBSUB_TOPIC_MISC, req, {
        logType: 'BookCartClaimed',
        cartId,
        wallet: evmWallet,
        email,
        loginMethod: 'autoClaim',
        allItemsAutoClaimed,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    const errorMessage = (err as Error).message;
    if (errorMessage !== 'PAYMENT_ALREADY_PROCESSED') {
      publisher.publish(PUBSUB_TOPIC_MISC, req, {
        logType: 'BookNFTPurchaseError',
        type: 'x402',
        paymentId,
        cartId,
        email,
        error: (err as Error).toString(),
        errorMessage,
        errorStack: (err as Error).stack,
      });
      await likeNFTBookCartCollection.doc(cartId).update({
        status: 'error',
        email: email || undefined,
      });
    }
  }
}

// Format + price a cart for x402. x402 settles USDC on Base, so every item must
// be a Base-chain book; reject mixed/other chains up front.
export async function prepareX402Cart(items: CartItem[], from?: string) {
  const itemInfos = await formatCartItemsWithInfo(items);
  itemInfos.forEach((item) => {
    const chain = item.chain
      || (isEVMClassId(item.classId as string) ? 'base' : 'like');
    if (chain !== 'base') {
      throw new ValidationError('X402_ONLY_SUPPORTS_BASE_CHAIN', 400);
    }
  });
  const itemPrices = calculateItemPrices(itemInfos, from);
  // No Stripe processing fee on the on-chain rail.
  const totalFeeInfo = calculateTotalFeeInfo(itemPrices);
  return { itemInfos, itemPrices, totalFeeInfo };
}

// Authorization boundary for the rail: the global flag must be on AND every
// seller in the cart must have opted in. Enforced server-side because the
// frontend gate is only cosmetic. A mixed cart (any seller not opted in) is
// rejected wholesale to avoid partial-cart settlement.
export async function assertX402SellersOptedIn(itemInfos: CartItemWithInfo[]) {
  if (!X402_PAYMENT_ENABLED) {
    throw new ValidationError('X402_PAYMENT_DISABLED', 403);
  }
  const ownerWallets = [...new Set(itemInfos.map((item) => item.ownerWallet))];
  const userInfos = await Promise.all(ownerWallets.map((wallet) => getBookUserInfo(wallet)));
  userInfos.forEach((info, index) => {
    if (!info?.isX402PaymentEnabled) {
      throw new ValidationError(`X402_SELLER_NOT_OPTED_IN: ${ownerWallets[index]}`, 403);
    }
  });
}

// --- x402 quote persistence ---------------------------------------------------
// /x402/new prices the cart server-side and stores the quote so /x402/settle is
// authoritative on amount/recipient/nonce and cannot be tampered with by the
// client. Stored under a suffixed doc id so it never collides with the real
// cart doc created at settle time.
function getX402QuoteRef(cartId: string) {
  return likeNFTBookCartCollection.doc(`${cartId}-x402quote`);
}

export interface X402Quote {
  cartId: string;
  paymentId: string;
  claimToken: string;
  itemInfos: CartItemWithInfo[];
  itemPrices: ItemPriceInfo[];
  totalFeeInfo: TransactionFeeInfo;
  requirements: X402PaymentRequirements;
  from?: string;
  ipCountry?: string;
  email?: string;
}

export async function createX402Quote(quote: Omit<X402Quote, 'cartId' | 'paymentId' | 'claimToken'>) {
  const cartId = uuidv4();
  const paymentId = cartId;
  const claimToken = crypto.randomBytes(32).toString('hex');
  const payload: any = {
    ...quote,
    cartId,
    paymentId,
    claimToken,
    status: 'quote',
    timestamp: FieldValue.serverTimestamp(),
  };
  await getX402QuoteRef(cartId).create(payload);
  return { cartId, paymentId, claimToken };
}

export type StoredX402Quote = X402Quote & { status: string; settleTxHash?: string };

export async function getX402Quote(cartId: string): Promise<StoredX402Quote> {
  const doc = await getX402QuoteRef(cartId).get();
  const data = doc.data();
  if (!data) throw new ValidationError('X402_QUOTE_NOT_FOUND', 404);
  return data as StoredX402Quote;
}

export async function markX402QuoteSettled(cartId: string, settleTxHash: string) {
  await getX402QuoteRef(cartId).update({
    status: 'settled',
    settleTxHash,
    settleTimestamp: FieldValue.serverTimestamp(),
  });
}

export { X402_VERSION };
