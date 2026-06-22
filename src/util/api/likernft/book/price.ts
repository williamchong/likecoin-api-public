import {
  LIKER_LAND_WAIVED_CHANNEL,
  NFT_BOOK_DEFAULT_FROM_CHANNEL,
} from '../../../../constant';
import {
  NFT_BOOK_LIKER_LAND_FEE_RATIO,
  NFT_BOOK_TIP_LIKER_LAND_FEE_RATIO,
  NFT_BOOK_LIKER_LAND_COMMISSION_RATIO,
  NFT_BOOK_LIKER_LAND_ART_FEE_RATIO,
} from '../../../../../config/config';
import { CartItemWithInfo, ItemPriceInfo, TransactionFeeInfo } from './type';

export function checkIsFromLikerLand(from: string): boolean {
  return from === NFT_BOOK_DEFAULT_FROM_CHANNEL;
}

export function calculateItemPrices(items: CartItemWithInfo[], from?: string): ItemPriceInfo[] {
  const itemPrices: ItemPriceInfo[] = items.map(
    (item) => {
      const isFromLikerLand = checkIsFromLikerLand(item.from || from || '');
      const isFree = !item.priceInDecimal && !item.customPriceDiffInDecimal;
      const isCommissionWaived = from === LIKER_LAND_WAIVED_CHANNEL;
      const customPriceDiffInDecimal = item.customPriceDiffInDecimal || 0;
      const { priceInDecimal, originalPriceInDecimal } = item;
      const priceInDecimalWithoutTip = priceInDecimal - customPriceDiffInDecimal;
      const priceDiscountInDecimal = Math.max(
        originalPriceInDecimal - priceInDecimalWithoutTip,
        0,
      );
      const likerLandFeeAmount = isFree ? 0 : Math.ceil(
        originalPriceInDecimal * NFT_BOOK_LIKER_LAND_FEE_RATIO,
      );
      const likerLandTipFeeAmount = Math.ceil(
        customPriceDiffInDecimal * NFT_BOOK_TIP_LIKER_LAND_FEE_RATIO,
      );
      const channelCommission = (from && !isCommissionWaived && !isFromLikerLand && !isFree)
        ? Math.max(Math.ceil(
          originalPriceInDecimal * NFT_BOOK_LIKER_LAND_COMMISSION_RATIO - priceDiscountInDecimal,
        ), 0)
        : 0;
      const likerLandCommission = (isFromLikerLand && !isFree)
        ? Math.max(Math.ceil(
          originalPriceInDecimal * NFT_BOOK_LIKER_LAND_COMMISSION_RATIO - priceDiscountInDecimal,
        ), 0)
        : 0;
      const likerLandArtFee = (item.isLikerLandArt && !isFree)
        ? Math.ceil(originalPriceInDecimal * NFT_BOOK_LIKER_LAND_ART_FEE_RATIO)
        : 0;

      const payload: ItemPriceInfo = {
        quantity: item.quantity,
        currency: 'usd',
        priceInDecimal,
        customPriceDiffInDecimal,
        originalPriceInDecimal,
        likerLandTipFeeAmount,
        likerLandFeeAmount,
        likerLandCommission,
        channelCommission,
        likerLandArtFee,
      };
      if (item.classId) payload.classId = item.classId;
      if (item.priceIndex !== undefined) payload.priceIndex = item.priceIndex;
      if (item.stripePriceId) payload.stripePriceId = item.stripePriceId;
      return payload;
    },
  );
  return itemPrices;
}

// Aggregate per-item prices into a cart-level fee breakdown. royaltyToSplit is
// what's left after platform/channel/art fees and is the amount paid out to
// authors. stripeFeeAmount is a flat cart-level fee (0 on the on-chain rail).
export function calculateTotalFeeInfo(
  itemPrices: ItemPriceInfo[],
  stripeFeeAmount = 0,
): TransactionFeeInfo {
  return itemPrices.reduce(
    (acc, item) => ({
      priceInDecimal: acc.priceInDecimal + item.priceInDecimal * item.quantity,
      originalPriceInDecimal: acc.originalPriceInDecimal
        + item.originalPriceInDecimal * item.quantity,
      likerLandTipFeeAmount: acc.likerLandTipFeeAmount + item.likerLandTipFeeAmount * item.quantity,
      likerLandFeeAmount: acc.likerLandFeeAmount + item.likerLandFeeAmount * item.quantity,
      likerLandCommission: acc.likerLandCommission + item.likerLandCommission * item.quantity,
      channelCommission: acc.channelCommission + item.channelCommission * item.quantity,
      likerLandArtFee: acc.likerLandArtFee + item.likerLandArtFee * item.quantity,
      customPriceDiffInDecimal: acc.customPriceDiffInDecimal
        + item.customPriceDiffInDecimal * item.quantity,
      stripeFeeAmount: acc.stripeFeeAmount,
      royaltyToSplit:
        acc.royaltyToSplit
        + Math.max(
          item.priceInDecimal
          - item.likerLandFeeAmount
          - item.likerLandTipFeeAmount
          - item.likerLandCommission
          - item.channelCommission
          - item.likerLandArtFee,
          0,
        ) * item.quantity,
    }),
    {
      priceInDecimal: 0,
      originalPriceInDecimal: 0,
      stripeFeeAmount,
      likerLandTipFeeAmount: 0,
      likerLandFeeAmount: 0,
      likerLandCommission: 0,
      channelCommission: 0,
      likerLandArtFee: 0,
      customPriceDiffInDecimal: 0,
      royaltyToSplit: 0,
    },
  );
}
