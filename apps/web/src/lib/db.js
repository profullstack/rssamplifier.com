import { createClient } from '@supabase/supabase-js';

/**
 * Service-role Supabase client.
 *
 * Every write in this app goes through the server — submissions are anonymous
 * and the crawler is a daemon — so there is no browser-side client and no anon
 * key in the bundle. Reads use the same client for simplicity; RLS already
 * allows public select on feeds and items.
 *
 * The key is read through a non-literal property access. Next inlines
 * `process.env.FOO` at build time, which would bake a build-time value into the
 * image and ignore the one Railway injects at runtime.
 *
 * @returns {import('@supabase/supabase-js').SupabaseClient}
 */
export function db() {
  const env = process.env;
  const url = env['SUPABASE_URL'];
  const key = env['SUPABASE_SERVICE_ROLE_KEY'];

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Public origin of the site, without a trailing slash.
 *
 * @returns {string}
 */
export function siteUrl() {
  return (process.env['SITE_URL'] || 'https://rssamplifier.com').replace(/\/+$/, '');
}
