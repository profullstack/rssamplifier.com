import test from 'node:test';
import assert from 'node:assert/strict';

// The fetcher's whole job is to be harmless when the ad network is not there,
// so most of what is tested here is failure. Each case stubs global fetch and
// re-imports the module, because the module caches its results by design and a
// shared cache across cases would make them test each other.

const FIELDS = {
  ok: true,
  count: 1,
  items: [
    {
      guid: 'tag:crawlproof.com,2026:ad/slot-1/d/2026-08-18',
      title: '[Sponsored] Ship faster with Widgets',
      headline: 'Ship faster with Widgets',
      body: 'Deploy in one command, roll back in one more.',
      cta: 'Try it free',
      url: 'https://crawlproof.com/api/ads/click?i=imp-1&s=slot-1',
      publishedAt: '2026-08-18T00:00:00.000Z',
      html: '<p><strong>Sponsored</strong></p>',
      label: 'Sponsored',
      tier: 'paid',
    },
  ],
};

/**
 * Load a fresh copy of the module with `fetch` stubbed.
 *
 * The cache-buster on the specifier is what makes each case independent: the
 * module holds an in-process TTL cache, so a second import of the same URL
 * would answer from the first case's results.
 *
 * @param {(url: string) => Promise<Response>|Response} impl
 * @param {Record<string, string>} [env]
 */
async function load(impl, env = {}) {
  const saved = { fetch: globalThis.fetch, ...pick(env) };
  globalThis.fetch = async (url) => impl(String(url));
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  const mod = await import(`../src/lib/feedAds.js?case=${Math.random()}`);

  return {
    mod,
    restore() {
      globalThis.fetch = saved.fetch;
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    },
  };
}

function pick(env) {
  return Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('maps an as=fields payload onto a syndication item', async () => {
  const { mod, restore } = await load(() => jsonRes(FIELDS));
  try {
    const [item] = await mod.fetchFeedAds(1);

    assert.equal(item.id, FIELDS.items[0].guid);
    // The click URL, not the advertiser's own site: that redirector is what
    // meters the click and pays the publisher.
    assert.equal(item.url, FIELDS.items[0].url);
    // The title arrives with its disclosure prefix already applied and is used
    // as-is, rather than re-assembled here from `headline`.
    assert.equal(item.title, '[Sponsored] Ship faster with Widgets');
    assert.equal(item.content_html, FIELDS.items[0].html);
    assert.equal(item.published_at, '2026-08-18T00:00:00.000Z');
    assert.equal(item.sponsored, true);
  } finally {
    restore();
  }
});

test('asks for the slot, the field shape, and a surface tag', async () => {
  let seen = '';
  const { mod, restore } = await load((url) => {
    seen = url;
    return jsonRes(FIELDS);
  });
  try {
    await mod.fetchFeedAds(2, { src: 'topic' });

    assert.match(seen, /^https:\/\/crawlproof\.com\/api\/ads\/feed\?/);
    assert.match(seen, /as=fields/);
    assert.match(seen, /[?&]n=2/);
    assert.match(seen, /src=topic/);
  } finally {
    restore();
  }
});

test('returns nothing when the ad server errors', async () => {
  const { mod, restore } = await load(() => jsonRes({ ok: false }, 500));
  try {
    assert.deepEqual(await mod.fetchFeedAds(1), []);
  } finally {
    restore();
  }
});

test('returns nothing when the ad server hangs or refuses', async () => {
  const { mod, restore } = await load(() => {
    throw new Error('ECONNREFUSED');
  });
  try {
    // A feed is the product and an ad is revenue on top of it, so there is no
    // path out of here that throws into the caller.
    assert.deepEqual(await mod.fetchFeedAds(1), []);
  } finally {
    restore();
  }
});

test('returns nothing when the payload is not the shape it claims', async () => {
  const { mod, restore } = await load(() => new Response('<html>oops</html>', { status: 200 }));
  try {
    assert.deepEqual(await mod.fetchFeedAds(1), []);
  } finally {
    restore();
  }
});

test('drops an item missing an identity or a link', async () => {
  const { mod, restore } = await load(() =>
    jsonRes({
      ok: true,
      items: [
        { ...FIELDS.items[0], guid: '' },
        { ...FIELDS.items[0], url: '' },
        { ...FIELDS.items[0], title: '' },
        FIELDS.items[0],
      ],
    }),
  );
  try {
    // Without a guid a reader shows the ad again on every poll; without a link
    // there is nothing to click. Neither is a degraded ad.
    assert.equal((await mod.fetchFeedAds(4)).length, 1);
  } finally {
    restore();
  }
});

test('asks for nothing when no ad would be placed', async () => {
  let calls = 0;
  const { mod, restore } = await load(() => {
    calls += 1;
    return jsonRes(FIELDS);
  });
  try {
    assert.deepEqual(await mod.fetchFeedAds(0), []);
    assert.equal(calls, 0, 'a feed too short to carry an ad must not pay for the round trip');
  } finally {
    restore();
  }
});

test('FEED_ADS=0 turns every sponsored item off without a deploy', async () => {
  let calls = 0;
  const { mod, restore } = await load(
    () => {
      calls += 1;
      return jsonRes(FIELDS);
    },
    { FEED_ADS: '0' },
  );
  try {
    assert.equal(mod.feedAdsEnabled(), false);
    assert.deepEqual(await mod.fetchFeedAds(3), []);
    assert.equal(calls, 0);
  } finally {
    restore();
  }
});

test('reuses a fetched ad rather than burning an impression per request', async () => {
  let calls = 0;
  const { mod, restore } = await load(() => {
    calls += 1;
    return jsonRes(FIELDS);
  });
  try {
    await mod.fetchFeedAds(1, { src: 'topic' });
    await mod.fetchFeedAds(1, { src: 'topic' });
    await mod.fetchFeedAds(1, { src: 'topic' });

    // The default identity rotation is daily, so three fetches would have
    // metered three impressions for an item carrying one guid — reach the
    // advertiser paid for and nobody received.
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test('caches the empty answer too, so an unsold slot is not re-asked per request', async () => {
  let calls = 0;
  const { mod, restore } = await load(() => {
    calls += 1;
    return jsonRes({ ok: true, count: 0, items: [] });
  });
  try {
    await mod.fetchFeedAds(1);
    await mod.fetchFeedAds(1);
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});
