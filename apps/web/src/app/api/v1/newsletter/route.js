import { newsletterStatus, noStoreJson } from '../../../../lib/newsletterApi.js';

export const dynamic = 'force-dynamic';

/**
 * The weekly digest: schedule, next send, list size, the latest issue.
 * Public. Your own subscription is /api/v1/me/newsletter.
 */
export async function GET() {
  return noStoreJson(await newsletterStatus());
}
