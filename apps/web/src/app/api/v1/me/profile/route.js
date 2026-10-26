import { createProfileHandlers } from '@profullstack/profile';
import { profileStore } from '@rssamplifier/auth';

import { db } from '../../../../../lib/db.js';
import { currentUser } from '../../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

/**
 * The signed-in reader's signup profile: GET it, PUT a whole one, PATCH some
 * fields. Session cookie only; anybody else gets a 401.
 *
 * Built on first request rather than at import, so `next build` never opens
 * the database pool.
 */
let handlers = null;

function profileHandlers() {
  handlers ??= createProfileHandlers({
    store: profileStore(db()),
    getUser: async () => {
      const user = await currentUser();
      return user ? { id: String(user.id), email: String(user.email) } : null;
    },
  });
  return handlers;
}

/** @param {Request} req */
export const GET = (req) => profileHandlers().GET(req);
/** @param {Request} req */
export const PUT = (req) => profileHandlers().PUT(req);
/** @param {Request} req */
export const PATCH = (req) => profileHandlers().PATCH(req);
