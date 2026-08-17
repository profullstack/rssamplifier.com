import { Readable } from 'node:stream';

import Busboy from 'busboy';

/**
 * Reading an upload without holding it.
 *
 * `req.formData()` buffers the entire body before returning, so a catalogue
 * costs its own size in memory before a single feed has been queued — and
 * `file.text()` then costs it again, this time as a string, which Node refuses
 * to build past 512 MiB. Neither limit is one an OPML import should ever meet,
 * so the upload is read as a stream instead: busboy for the browser's multipart
 * form, and the request body itself for a client that can just PUT the file.
 */

/**
 * The largest OPML upload the endpoint will accept.
 *
 * Ten gibibytes is not a guess at what anyone will send — it is roughly fifty
 * million feeds, far more than the syndicated web has — it is the point past
 * which we would rather answer 413 than keep a socket open indefinitely. The
 * number is honest now in a way it could not have been before: nothing in the
 * path holds the document, so the only thing an upload this size consumes is
 * the time it takes to arrive.
 */
export const OPML_MAX_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * Content types that mean "the body is the OPML file".
 *
 * Deliberately not `text/plain`: a client posting a list of URLs as plain text
 * is a thing that happens, and reading it as a catalogue would find no outlines
 * and silently accept nothing.
 */
const RAW_TYPES = ['application/xml', 'text/xml', 'text/x-opml', 'application/opml+xml'];

/**
 * @param {string} contentType
 * @returns {boolean}
 */
export function isRawOpmlUpload(contentType) {
  const type = contentType.split(';')[0].trim().toLowerCase();
  return RAW_TYPES.includes(type) || type.endsWith('+xml');
}

/**
 * The chunks of a raw-body upload.
 *
 * @param {Request} req
 * @returns {AsyncIterable<Uint8Array>}
 */
export function rawBodyChunks(req) {
  if (!req.body) return (async function* () {})();
  return /** @type {AsyncIterable<Uint8Array>} */ (req.body);
}

/**
 * The first file part of a multipart upload, as a stream, plus the fields.
 *
 * Two things about the shape here are forced by how multipart works rather than
 * chosen. The file is resolved before the fields are, because the browser sends
 * parts in document order and `/submit` puts the file input above the email
 * one — so `fields` is a promise that settles after the file stream has been
 * drained, not an object available up front. And the file stream *must* be
 * consumed: busboy will not emit anything further until it is, so ignoring it
 * deadlocks the request rather than skipping the part.
 *
 * @param {Request} req
 * @param {string} contentType
 * @returns {Promise<{ name: string|null, filename: string|null, chunks: AsyncIterable<Uint8Array>, fields: Promise<Record<string, string>> }>}
 */
export function multipartFile(req, contentType) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: { 'content-type': contentType } });

    /** @type {Record<string, string>} */
    const fields = {};
    let handed = false;

    /**
     * Settles once busboy has seen the whole body, so late fields are in.
     *
     * It resolves on an error rather than rejecting: a truncated upload already
     * surfaces through the file stream, which is what the import is driven by,
     * and a second rejection here would only turn "the client hung up" into an
     * unhandled one. Whatever fields did arrive are still worth having.
     */
    const finished = new Promise((done) => {
      bb.on('close', () => done(fields));
      bb.on('error', () => done(fields));
    });

    bb.on('field', (name, value) => {
      fields[name] = value;
    });

    bb.on('file', (name, stream, info) => {
      if (handed) {
        // A second file part is not something this endpoint takes, but it still
        // has to be drained or the parse stalls.
        stream.resume();
        return;
      }
      handed = true;
      resolve({
        name,
        filename: info?.filename ?? null,
        chunks: stream,
        fields: finished,
      });
    });

    bb.on('close', () => {
      if (!handed) {
        handed = true;
        resolve({
          name: null,
          filename: null,
          chunks: (async function* () {})(),
          fields: Promise.resolve(fields),
        });
      }
    });

    bb.on('error', (err) => {
      if (!handed) reject(err);
    });

    if (!req.body) {
      bb.end();
      return;
    }

    Readable.fromWeb(/** @type {any} */ (req.body)).pipe(bb);
  });
}

/**
 * Pass chunks through untouched while keeping the head of them.
 *
 * The audit copy and the queue want the same bytes, and the bytes go past once.
 * Rather than read the upload twice or buffer it to hand out later, the head is
 * taken off the stream as it flows — bounded by the same caps the stored copy
 * is, so what accumulates here is never more than one row's worth.
 *
 * @param {AsyncIterable<Uint8Array|string>} source
 * @param {(head: string) => boolean} take called with each chunk's text; returns false once it has enough
 * @returns {AsyncIterable<Uint8Array|string>}
 */
export async function* teeHead(source, take) {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let wanted = true;

  for await (const chunk of source) {
    if (wanted) {
      const text =
        typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      wanted = take(text);
    }
    yield chunk;
  }
}
