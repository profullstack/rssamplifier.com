/**
 * Refuse a publisher that has been removed from the directory before the
 * reader's frame makes any request to that host.
 *
 * @param {string} url
 * @param {(url: string) => Promise<boolean>} isRemovedUrl
 * @returns {Promise<Response|null>}
 */
export async function removedPublisherResponse(url, isRemovedUrl) {
  if (!(await isRemovedUrl(url))) return null;

  return new Response('This publisher has been removed from RSS Amplifier.', {
    status: 410,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-robots-tag': 'noindex',
    },
  });
}
