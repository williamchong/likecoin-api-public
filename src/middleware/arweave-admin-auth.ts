import { ARWEAVE_RECONCILE_ADMIN_TOKEN } from '../../config/config';

import { makeBearerTokenAuth } from './bearer-auth';

// Guards the admin-triggered Irys funding reconcile endpoint (re-notifies stranded
// deposits). Uses a dedicated secret, triggered by Cloud Scheduler or an operator.
export const arweaveAdminAuth = makeBearerTokenAuth({
  token: ARWEAVE_RECONCILE_ADMIN_TOKEN,
  notConfiguredError: 'ARWEAVE_RECONCILE_ADMIN_TOKEN_NOT_CONFIGURED',
  malformedError: 'ARWEAVE_ADMIN_TOKEN_MALFORMED',
});

export default arweaveAdminAuth;
