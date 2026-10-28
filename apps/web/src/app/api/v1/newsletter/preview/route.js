import { newsletterPreview, noStoreJson } from '../../../../../lib/newsletterApi.js';

export const dynamic = 'force-dynamic';

/**
 * This week's digest as it would be built right now, from the directory as it
 * stands. Public and read-only: nothing is stored and nobody is mailed.
 */
export async function GET() {
  const issue = await newsletterPreview();
  return noStoreJson(issue ? { issue } : { issue: null, reason: 'nothing-to-say' });
}
