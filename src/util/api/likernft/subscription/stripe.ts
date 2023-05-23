import axios from 'axios';
import Stripe from 'stripe';
import stripe from '../../../stripe';
import { likeNFTSubscriptionUserCollection } from '../../../firebase';
import { ValidationError } from '../../../ValidationError';
import { IS_TESTNET, LIKER_LAND_HOSTNAME, PUBSUB_TOPIC_MISC } from '../../../../constant';
import publisher from '../../../gcloudPub';
import {
  LIKER_NFT_SUBSCRIPTION_PRICE_ID,
  NFT_MESSAGE_WEBHOOK,
} from '../../../../../config/config';

async function stripeNFTPostSlackMessage(
  subscriptionId: string,
  email: string,
  wallet: string,
) {
  try {
    const words: string[] = [];
    if (IS_TESTNET) {
      words.push('[🚧 TESTNET]');
    }
    words.push('NFT subsctipion payment');
    const text = words.join(' ');

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: wallet ? `*Wallet*\n<https://${LIKER_LAND_HOSTNAME}/${wallet}|${wallet}>` : `*Email*\n${email}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Subscription ID*\n${subscriptionId}`,
          },
        ],
      },
    ];

    await axios.post(NFT_MESSAGE_WEBHOOK, { text, blocks });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
}

export async function processStripeNFTSubscriptionSession(
  session: Stripe.Checkout.Session,
  req: Express.Request,
) {
  const {
    subscription: subscriptionId,
    customer: customerId,
    customer_email: customerEmail,
    customer_details: customerDetails,
  } = session;
  const email = customerEmail || customerDetails?.email || null;
  if (!subscriptionId) return false;
  const subscription: Stripe.Subscription = typeof subscriptionId === 'string' ? await stripe.subscriptions.retrieve(subscriptionId) : subscriptionId;
  const {
    items: { data: items },
    metadata: { wallet },
    current_period_start: currentPeriodStart,
    current_period_end: currentPeriodEnd,
  } = subscription;
  const priceIds = items.map((i) => i.price);
  const priceId = priceIds.find((p) => p.id === LIKER_NFT_SUBSCRIPTION_PRICE_ID);
  if (!priceId) throw new ValidationError('TARGET_PRICE_ID_NOT_FOUND');
  try {
    await likeNFTSubscriptionUserCollection.doc(wallet).set({
      type: 'stripe',
      currentBillingPeriod: 'month',
      currentPeriodStart,
      currentPeriodEnd,
      email,
      stripe: {
        customerId,
        subscriptionId,
        priceId,
      },
      timestamp: Date.now(),
    }, { merge: true });
    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'LikerNFTSubscriptionCreated',
      type: 'stripe',
      subscriptionId,
      wallet,
      email,
      currentPeriodStart,
      currentPeriodEnd,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);
    const errorMessage = (error as Error).message;
    const errorStack = (error as Error).stack;
    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'LikerNFTFiatSubscriptionError',
      type: 'stripe',
      subscriptionId,
      wallet,
      error: (error as Error).toString(),
      errorMessage,
      errorStack,
    });
    return false;
  }
  if (NFT_MESSAGE_WEBHOOK) {
    await stripeNFTPostSlackMessage(
      subscriptionId as string,
      email as string,
      wallet,
    );
  }
  return true;
}

export async function processStripeNFTSubscriptionInvoice(
  invoice: Stripe.Invoice,
  req: Express.Request,
) {
  const {
    customer: customerId,
    subscription: subscriptionId,
  } = invoice;
  if (!subscriptionId) return false;
  const subscription: Stripe.Subscription = typeof subscriptionId === 'string' ? await stripe.subscriptions.retrieve(subscriptionId) : subscriptionId;
  const {
    current_period_start: currentPeriodStart,
    current_period_end: currentPeriodEnd,
    metadata: { wallet },
    items: { data: items },
  } = subscription;
  const priceIds = items.map((i) => i.price);
  const priceId = priceIds.find((p) => p.id === LIKER_NFT_SUBSCRIPTION_PRICE_ID);
  if (!priceId) throw new ValidationError('TARGET_PRICE_ID_NOT_FOUND');
  const customer: Stripe.Customer | Stripe.DeletedCustomer = await stripe.customers.retrieve(
    customerId as string,
  );
  if (customer.deleted) throw new ValidationError(`Customer ${customerId} is deleted`);
  const { email } = customer;
  try {
    await likeNFTSubscriptionUserCollection.doc(wallet).update({
      type: 'stripe',
      currentBillingPeriod: 'month',
      currentPeriodStart,
      currentPeriodEnd,
      currentPeriodMints: 0,
      totalMints: 0,
    });
    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'LikerNFTSubscriptionRenewed',
      type: 'stripe',
      subscriptionId,
      wallet,
      email,
      currentPeriodStart,
      currentPeriodEnd,
    });
  } catch (error) {
  // eslint-disable-next-line no-console
    console.error(error);
    const errorMessage = (error as Error).message;
    const errorStack = (error as Error).stack;
    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'LikerNFTFiatSubscriptionError',
      type: 'stripe',
      subscriptionId,
      wallet,
      error: (error as Error).toString(),
      errorMessage,
      errorStack,
    });
    return false;
  }
  if (NFT_MESSAGE_WEBHOOK) {
    await stripeNFTPostSlackMessage(
      subscriptionId as string,
      email as string,
      wallet,
    );
  }
  return true;
}