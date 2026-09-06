import { partners } from '../../../lib/partners.js';

/**
 * The seller side: where a publisher signs up, proves they own the site behind
 * a feed we index, and gets paid a share of what crawlers pay for access.
 *
 * 404 when PARTNER_VERIFY_SECRET is unset, because the programme cannot run
 * safely without it and a half-working signup is worse than none.
 */
export const dynamic = 'force-dynamic';

async function handle(request) {
  const program = partners();
  if (!program) return new Response('Not found', { status: 404 });
  return (await program.handle(request)) ?? new Response('Not found', { status: 404 });
}

export const GET = handle;
export const POST = handle;
export const HEAD = handle;
