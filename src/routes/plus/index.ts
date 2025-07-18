import { Router } from 'express';
import { jwtAuth } from '../../middleware/jwt';
import { ValidationError } from '../../util/ValidationError';
import { getBookUserInfoFromWallet } from '../../util/api/likernft/book/user';
import stripe from '../../util/stripe';
import { BOOK3_HOSTNAME, PUBSUB_TOPIC_MISC } from '../../constant';
import { createNewPlusCheckoutSession } from '../../util/api/plus';
import publisher from '../../util/gcloudPub';

const router = Router();

router.post('/new', jwtAuth('write:plus'), async (req, res, next) => {
  let { period = 'monthly' } = req.query;
  const { from } = req.query;
  const {
    gaClientId,
    gaSessionId,
    gadClickId,
    gadSource,
    fbClickId,
    referrer,
    userAgent,
    clientIp,
    utmCampaign,
    utmSource,
    utmMedium,
    hasFreeTrial,
    mustCollectPaymentMethod,
  } = req.body;
  try {
    // Ensure period is either 'monthly' or 'yearly'
    if (period !== 'monthly' && period !== 'yearly') {
      period = 'monthly'; // Default to monthly if invalid
    }
    const session = await createNewPlusCheckoutSession(
      {
        period: period as 'monthly' | 'yearly',
        hasFreeTrial,
        mustCollectPaymentMethod,
      },
      {
        from: from as string,
        gaClientId,
        gaSessionId,
        gadClickId,
        gadSource,
        fbClickId,
        referrer,
        userAgent,
        clientIp,
        utm: {
          campaign: utmCampaign,
          source: utmSource,
          medium: utmMedium,
        },
      },
      req,
    );
    res.json({
      sessionId: session.id,
      url: session.url,
    });

    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'PlusCheckoutSessionCreated',
      sessionId: session.id,
      period,
      wallet: req.user?.wallet,
      likeWallet: req.user?.likeWallet,
      evmWallet: req.user?.evmWallet,
      from,
      gadClickId,
      gadSource,
      fbClickId,
      utmCampaign,
      utmSource,
      utmMedium,
      referrer,
    });
  } catch (error) {
    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'PlusCheckoutSessionError',
      period,
      wallet: req.user?.wallet,
      likeWallet: req.user?.likeWallet,
      evmWallet: req.user?.evmWallet,
      error: (error as Error).message,
    });
    next(error);
  }
});

router.post('/portal', jwtAuth('write:plus'), async (req, res, next) => {
  try {
    const { wallet } = req.user;
    const userInfo = await getBookUserInfoFromWallet(wallet);
    const { bookUserInfo } = userInfo || {};
    const customerId = bookUserInfo?.stripeCustomerId;
    if (!customerId) {
      publisher.publish(PUBSUB_TOPIC_MISC, req, {
        logType: 'PlusBillingPortalNoCustomerId',
        wallet,
      });
      throw new ValidationError('No Stripe customer ID found for this user. Please subscribe first.', 400);
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `https://${BOOK3_HOSTNAME}/account`,
    });

    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'PlusBillingPortalSessionCreated',
      sessionId: session.id,
      wallet,
      customerId,
    });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    publisher.publish(PUBSUB_TOPIC_MISC, req, {
      logType: 'PlusBillingPortalError',
      wallet: req.user?.wallet,
      error: (error as Error).message,
    });
    next(error);
  }
});

export default router;
