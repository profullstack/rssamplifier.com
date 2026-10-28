import { WebhookError } from '@rssamplifier/notify';

import { hooks, webhookOwner } from '../webhooks.js';

/**
 * Webhook tools: the /api/v1/webhooks API for an agent.
 *
 * Unlike the directory tools these act for an account, so every one needs an
 * rssamplifier API key in the Authorization header (`Bearer rsa_...`, minted
 * on /account). The one event is `posts.published`: a batch of new posts from
 * what the account has switched alerts on for.
 */

const AUTH = 'Needs one of your rssamplifier API keys in the Authorization header (Bearer rsa_..., from /account).';

const ID = { type: 'string', description: 'The webhook endpoint id (wh_...), from list_webhooks.' };

/** @type {import('./tools.js').Tool[]} */
export const WEBHOOK_TOOLS = [
  {
    name: 'list_webhooks',
    title: 'List your webhooks',
    description: `Your webhook endpoints (url, event filters, on/off, failures) and the event types this site emits. ${AUTH}`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (_args, ctx) =>
      withOwner(ctx, async (owner) => ({
        endpoints: await hooks().listEndpoints(owner),
        event_types: hooks().eventTypes,
      })),
  },
  {
    name: 'create_webhook',
    title: 'Add a webhook',
    description: `Register an https URL to receive your alerts as signed POSTs (CloudEvents body, Standard Webhooks signature headers, plus x-rssamplifier-signature: sha256=<hex HMAC of the body>). Returns the endpoint and its signing secret (whsec_...), shown here once. ${AUTH}`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'https URL that resolves to a public address.' },
        events: { type: 'array', items: { type: 'string' }, description: 'Event patterns; default ["*"]. The one event is posts.published.' },
        description: { type: 'string', description: 'What it is, for your own list.' },
      },
      required: ['url'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (args, ctx) =>
      withOwner(ctx, (owner) =>
        hooks().createEndpoint(owner, { url: String(args?.url ?? ''), events: args?.events, description: args?.description ?? '' }),
      ),
  },
  {
    name: 'update_webhook',
    title: 'Change a webhook',
    description: `Change an endpoint's url, events, description, or switch it on/off (turning it back on clears its failure count). ${AUTH}`,
    inputSchema: {
      type: 'object',
      properties: {
        id: ID,
        url: { type: 'string' },
        events: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (args, ctx) =>
      withOwner(ctx, (owner) => {
        const { id, ...patch } = args ?? {};
        return hooks().updateEndpoint(owner, String(id ?? ''), patch);
      }),
  },
  {
    name: 'delete_webhook',
    title: 'Remove a webhook',
    description: `Delete an endpoint and its delivery log. ${AUTH}`,
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (args, ctx) => withOwner(ctx, (owner) => hooks().deleteEndpoint(owner, String(args?.id ?? ''))),
  },
  {
    name: 'test_webhook',
    title: 'Send a test delivery',
    description: `Send a signed webhook.test event to the endpoint now and report the HTTP status. ${AUTH}`,
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (args, ctx) => withOwner(ctx, (owner) => hooks().test(owner, String(args?.id ?? ''))),
  },
  {
    name: 'rotate_webhook_secret',
    title: "Replace a webhook's signing secret",
    description: `Mint a new signing secret for the endpoint and return it; the old one stops working at once. ${AUTH}`,
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (args, ctx) => withOwner(ctx, (owner) => hooks().rotateSecret(owner, String(args?.id ?? ''))),
  },
  {
    name: 'webhook_deliveries',
    title: 'Webhook delivery log',
    description: `Recent deliveries (status, attempts, last HTTP status or error, payload), for one endpoint or all of yours. ${AUTH}`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { ...ID, description: 'Only this endpoint; omit for every endpoint.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (args, ctx) =>
      withOwner(ctx, async (owner) => ({
        deliveries: await hooks().deliveries(owner, {
          endpointId: args?.id ? String(args.id) : undefined,
          limit: Number(args?.limit) || 50,
        }),
      })),
  },
];

/**
 * Run `fn` as the account behind the request's API key; a missing key or a
 * hub refusal is a tool error the model can read and act on.
 *
 * @template T
 * @param {{ header?: (name: string) => string|null }} ctx
 * @param {(owner: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withOwner(ctx, fn) {
  const headers = new Headers();
  const auth = ctx?.header?.('authorization');
  if (auth) headers.set('authorization', auth);
  const owner = await webhookOwner(new Request('http://mcp.local/', { headers }), { user: async () => null });
  if (!owner) throw toolError(`send an API key: ${AUTH}`);
  try {
    return await fn(owner);
  } catch (err) {
    if (err instanceof WebhookError) throw toolError(err.message);
    throw err;
  }
}

/** @param {string} message */
function toolError(message) {
  const err = /** @type {Error & { toolError?: true }} */ (new Error(message));
  err.toolError = true;
  return err;
}
