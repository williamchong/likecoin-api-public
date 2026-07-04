import { Request, Response, NextFunction } from 'express';

import { constantTimeEqual } from '../util/misc';
import { ValidationError } from '../util/ValidationError';

const BEARER_PREFIX = 'Bearer ';

// Factory for admin endpoints guarded by a dedicated bearer secret: 500 when the
// secret is unconfigured, 401 on a malformed header, constant-time token compare.
export function makeBearerTokenAuth({
  token,
  notConfiguredError,
  malformedError,
}: {
  token: string;
  notConfiguredError: string;
  malformedError: string;
}) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) {
      next(new ValidationError(notConfiguredError, 500));
      return;
    }
    const header = req.get('Authorization');
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      next(new ValidationError(malformedError, 401));
      return;
    }
    const provided = header.slice(BEARER_PREFIX.length);
    if (!constantTimeEqual(provided, token)) {
      next(new ValidationError('UNAUTHORIZED', 401));
      return;
    }
    next();
  };
}

export default makeBearerTokenAuth;
