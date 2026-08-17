/**
 * How big is this image, read from the file's own header.
 *
 * The directory needs the answer for one decision: whether a publisher's picture
 * is large enough to hand a social-media crawler as a card. Open Graph wants at
 * least 200×200 and Twitter will not render a large card under 300×157, so
 * "there is an image" is not enough — a 32×32 favicon presented as a card is
 * worse than no card at all, which is exactly why the feed pages had none.
 *
 * Every format here states its dimensions in the first few bytes, so this needs
 * no decoder and no dependency: the caller fetches a couple of kilobytes with a
 * ranged GET and passes them in. Nothing is decoded, so a malformed or hostile
 * file costs a bounds check, not a decode.
 *
 * The formats are the ones publishers actually serve as og:image or as feed
 * cover art. AVIF and SVG are recognised but return no dimensions — one would
 * need a real box walk, the other genuinely has no pixel size — and the caller
 * treats "known format, unknown size" as a picture it can show but not vouch
 * for as a card.
 */

/**
 * @typedef {{ type: string, width: number, height: number }} ImageSize
 */

/**
 * Read the dimensions out of an image header.
 *
 * @param {Uint8Array} bytes the start of the file — 2KB is plenty for all but
 *   the rare JPEG whose frame header sits behind a large EXIF thumbnail
 * @returns {ImageSize|null} null when the bytes are not an image at all
 */
export function imageSize(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null;

  return (
    png(bytes) ??
    gif(bytes) ??
    webp(bytes) ??
    jpeg(bytes) ??
    ico(bytes) ??
    bmp(bytes) ??
    isobmff(bytes) ??
    svg(bytes)
  );
}

/** Big-endian 32-bit read, or 0 past the end. */
function be32(b, at) {
  if (at + 3 >= b.length) return 0;
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

/** Big-endian 16-bit read. */
function be16(b, at) {
  if (at + 1 >= b.length) return 0;
  return (b[at] << 8) | b[at + 1];
}

/** Little-endian 16-bit read. */
function le16(b, at) {
  if (at + 1 >= b.length) return 0;
  return b[at] | (b[at + 1] << 8);
}

/** Little-endian 32-bit read. */
function le32(b, at) {
  if (at + 3 >= b.length) return 0;
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

/**
 * Do these bytes start with this ASCII string?
 *
 * @param {Uint8Array} b
 * @param {string} text
 * @param {number} [at]
 */
function starts(b, text, at = 0) {
  for (let i = 0; i < text.length; i += 1) {
    if (b[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function png(b) {
  // The 8-byte signature, then a length and the 'IHDR' chunk type, then the two
  // dimensions. IHDR is required by the spec to be the first chunk.
  if (!(b[0] === 0x89 && starts(b, 'PNG', 1))) return null;
  if (!starts(b, 'IHDR', 12)) return null;
  return { type: 'png', width: be32(b, 16), height: be32(b, 20) };
}

function gif(b) {
  if (!starts(b, 'GIF87a') && !starts(b, 'GIF89a')) return null;
  return { type: 'gif', width: le16(b, 6), height: le16(b, 8) };
}

function webp(b) {
  if (!starts(b, 'RIFF') || !starts(b, 'WEBP', 8)) return null;

  // Three sub-formats, three layouts. Lossy keeps 14-bit dimensions after a
  // 3-byte start code; lossless packs 14-bit pairs across four bytes; extended
  // states 24-bit canvas dimensions minus one.
  if (starts(b, 'VP8 ', 12)) {
    return { type: 'webp', width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }

  if (starts(b, 'VP8L', 12)) {
    const bits = le32(b, 21);
    return {
      type: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (starts(b, 'VP8X', 12)) {
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { type: 'webp', width, height };
  }

  return { type: 'webp', width: 0, height: 0 };
}

/**
 * Frame markers that carry the image's real dimensions.
 *
 * Baseline, extended, progressive and the arithmetic-coded and lossless
 * variants. Deliberately not every 0xFFCn: C4 is a Huffman table, C8 is a JPEG
 * extension and CC is an arithmetic-coding conditioning table, and reading two
 * of those as dimensions is how a JPEG ends up reported as 1×1.
 */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return null;

  // Walk the segment chain rather than guessing an offset: every JPEG puts its
  // frame header behind a variable number of application segments, and the EXIF
  // one alone can be tens of kilobytes.
  let at = 2;
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) {
      at += 1; // padding between segments is legal
      continue;
    }

    const marker = b[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Start of scan: the entropy-coded data begins and there is no header left
    // to find.
    if (marker === 0xda || marker === 0xd9) break;

    const length = be16(b, at + 2);
    if (length < 2) break;

    if (SOF.has(marker)) {
      return { type: 'jpeg', height: be16(b, at + 5), width: be16(b, at + 7) };
    }

    at += 2 + length;
  }

  // A JPEG whose frame header is past the bytes we were given. Known format,
  // unknown size — the caller decides what that is worth.
  return { type: 'jpeg', width: 0, height: 0 };
}

function ico(b) {
  if (!(b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0)) return null;
  // The directory entry stores each dimension in one byte, where 0 means 256.
  return { type: 'ico', width: b[6] || 256, height: b[7] || 256 };
}

function bmp(b) {
  if (!starts(b, 'BM')) return null;
  return { type: 'bmp', width: le32(b, 18), height: le32(b, 22) };
}

/**
 * AVIF and HEIC, recognised but not measured.
 *
 * The dimensions live in an `ispe` box nested several levels inside the meta
 * box, and walking there properly is a lot of code for a format that is a
 * rounding error in the directory. Recognising it is still worth doing: it means
 * the caller can tell "an image whose size I could not read" from "not an
 * image", and only the second is a reason to reject the URL.
 */
function isobmff(b) {
  if (!starts(b, 'ftyp', 4)) return null;
  const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
  if (!/^(avif|avis|heic|heix|hevc|mif1|msf1)$/.test(brand)) return null;
  return { type: brand.startsWith('avi') ? 'avif' : 'heic', width: 0, height: 0 };
}

/**
 * SVG, which has no pixel size unless it says so.
 *
 * Read anyway, because a vector logo is a perfectly good listing avatar even
 * though no social-media crawler will render one as a card.
 */
function svg(b) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 1024));
  if (!/<svg[\s>]/i.test(head)) return null;

  const attr = (name) => {
    const found = new RegExp(`\\b${name}\\s*=\\s*["']?\\s*([\\d.]+)`, 'i').exec(head);
    return found ? Math.round(Number(found[1])) : 0;
  };

  const box = /\bviewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);

  return {
    type: 'svg',
    width: attr('width') || (box ? Math.round(Number(box[1])) : 0),
    height: attr('height') || (box ? Math.round(Number(box[2])) : 0),
  };
}
