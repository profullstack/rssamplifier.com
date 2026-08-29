/**
 * The provider-neutral vocabulary (§9).
 *
 * Types only — this module holds no runtime code and exists so that the three
 * provider implementations, the session pool and the normaliser all describe
 * the same thing without importing each other.
 *
 * Two deliberate additions to the PRD's `XPost`. The spec carries `repostOfId`
 * and `quotedPostId` — ids alone — but an id is not enough to *render* either
 * one: a repost has no text of its own, so an item built from ids would be
 * blank, and a quote whose quoted half is an id reads as a non-sequitur. Every
 * upstream we support already sends the nested post, so `repostOf` and
 * `quotedPost` carry it and the ids stay for metadata and dedupe (§26, §27).
 */

/**
 * @typedef {'user'|'replies'|'media'|'search'|'list'} XFeedMode
 */

/**
 * @typedef {object} XFetchRequest
 * @property {XFeedMode} mode
 * @property {string} [username]
 * @property {string} [query]
 * @property {string} [listId]
 * @property {string} [cursor]
 * @property {number} [limit]
 */

/**
 * @typedef {object} XAuthor
 * @property {string} [id]
 * @property {string} username
 * @property {string} [displayName]
 * @property {string} [avatarUrl]
 */

/**
 * @typedef {object} XMedia
 * @property {'image'|'video'|'gif'} type
 * @property {string} url
 * @property {string} [previewUrl]
 * @property {number} [width]
 * @property {number} [height]
 */

/**
 * @typedef {object} XMetrics
 * @property {number} [replies]
 * @property {number} [reposts]
 * @property {number} [likes]
 * @property {number} [views]
 */

/**
 * @typedef {object} XPost
 * @property {string} id X's own post id — the dedupe key, as `x:<id>`
 * @property {string} url canonical x.com address
 * @property {string} text
 * @property {string} createdAt ISO 8601
 * @property {XAuthor} author
 * @property {string|null} [replyToId]
 * @property {string|null} [quotedPostId]
 * @property {string|null} [repostOfId]
 * @property {XPost|null} [quotedPost] the quoted post itself, when sent
 * @property {XPost|null} [repostOf] the original, when this is a repost
 * @property {XMedia[]} [media]
 * @property {XMetrics} [metrics]
 * @property {unknown} [raw]
 */

/**
 * @typedef {object} XSession
 * @property {string} id
 * @property {string} [authToken]
 * @property {string} [ct0]
 * @property {string} status
 * @property {string|null} [cooldownUntil]
 * @property {string|null} [lastUsedAt]
 */

/**
 * @typedef {object} XProviderContext
 * @property {XSession|null} [session]
 * @property {AbortSignal} [signal]
 * @property {typeof fetch} [fetch] injected in tests
 */

/**
 * @typedef {object} XFetchResult
 * @property {XPost[]} posts
 * @property {string} [nextCursor]
 * @property {string|null} [displayName] the account's own name, when upstream says
 * @property {string|null} [avatarUrl]
 */

/**
 * @typedef {object} XProvider
 * @property {string} name
 * @property {() => boolean} configured is this provider usable at all?
 * @property {() => Promise<boolean>} healthCheck
 * @property {(request: XFetchRequest, context: XProviderContext) => Promise<XFetchResult>} fetch
 */

export {};
