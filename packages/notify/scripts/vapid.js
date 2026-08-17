import { generateVapidKeys } from '../src/webpush.js';

/**
 * Mint a VAPID key pair for a deployment.
 *
 * `pnpm --filter @rssamplifier/notify vapid`, once, ever. The pair is the
 * application server's identity: every push subscription in the database was
 * created against the public half, so replacing it silently invalidates all of
 * them — browsers keep sending to the old key and every send comes back 403.
 *
 * The public half is not a secret. It is handed to every browser that subscribes
 * and is served from /api/alerts/push, which is why it is fine for it to sit in
 * the same environment file as the private half.
 */

const keys = generateVapidKeys();

console.log('Add these to the web service and the poller:');
console.log('');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:hello@rssamplifier.com');
console.log('');
console.log('Both services need the pair: the web app hands the public key to');
console.log('browsers, and the poller signs with the private one.');
