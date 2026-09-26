import type { ContainerId } from '../types.ts';

/**
 * What a byte scan can tell us. Deliberately separate from the full probe result:
 * this runs on the first kilobyte and decides which parser to spin up.
 */
export interface SniffResult {
  container: ContainerId | 'unknown';
  /** ISO-BMFF major brand, e.g. `qt  `, `isom`, `M4A `, `heic`. */
  brand?: string;
  /** EBML DocType, e.g. `webm` or `matroska`. */
  docType?: string;
  /**
   * How much we trust this. `definite` means a magic number matched unambiguously;
   * `probable` means we matched a weaker signature and a real parse should confirm.
   */
  confidence: 'definite' | 'probable' | 'unknown';
}

/** How many bytes the caller needs to read for a reliable sniff. */
export const SNIFF_BYTES = 65536;

const ascii = (b: Uint8Array, off: number, len: number): string =>
  String.fromCharCode(...b.subarray(off, off + len));

function startsWith(b: Uint8Array, sig: readonly number[], off = 0): boolean {
  if (b.length < off + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[off + i] !== sig[i]) return false;
  return true;
}

/**
 * Identify a container from its leading bytes.
 *
 * Extensions are never consulted. A `.jpg` may be a plain still, a Google Motion
 * Photo, or the still half of a Live Photo; a `.mov` may be an ordinary video or the
 * motion half of a Live Photo. Only content settles it.
 */
export function sniff(bytes: Uint8Array): SniffResult {
  if (bytes.length < 12) return { container: 'unknown', confidence: 'unknown' };

  /* --- ZIP: `.livp` and friends -------------------------------------- */
  // Checked early because a Live Photo package is a ZIP of a still plus a MOV.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return { container: 'zip', confidence: 'definite' };
  }

  /* --- RIFF family ---------------------------------------------------- */
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) {
    // bytes 4..8 are the little-endian size; the form type sits at 8..12
    const form = ascii(bytes, 8, 4);
    if (form === 'WEBP') return { container: 'webp', confidence: 'definite' };
    if (form === 'WAVE') return { container: 'wav', confidence: 'definite' };
    if (form === 'AVI ') return { container: 'unknown', confidence: 'probable' };
  }

  /* --- GIF ------------------------------------------------------------ */
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    // 'GIF8' — then '7a' or '9a'. Both are plain GIF to us.
    return { container: 'gif', confidence: 'definite' };
  }

  /* --- PNG (and APNG, distinguished later by the actl chunk) ---------- */
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { container: 'png', confidence: 'definite' };
  }

  /* --- JPEG ----------------------------------------------------------- */
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { container: 'jpeg', confidence: 'definite' };
  }

  /* --- ISO base media file format ------------------------------------- */
  // Structure: [size:4][type:4] — we need the first box to be `ftyp`,
  // then the major brand sits at offset 8.
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    return { container: containerForBrand(brand), brand, confidence: 'definite' };
  }

  /* --- EBML: Matroska and WebM are the same bytes, different DocType --- */
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    const docType = findEbmlDocType(bytes);
    if (docType === 'webm') return { container: 'webm', docType, confidence: 'definite' };
    if (docType === 'matroska') {
      return { container: 'matroska', docType, confidence: 'definite' };
    }
    // EBML but the DocType is past our window or unrecognised.
    return { container: 'matroska', confidence: 'probable' };
  }

  /* --- Ogg ------------------------------------------------------------ */
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return { container: 'ogg', confidence: 'definite' };
  }

  /* --- FLAC ----------------------------------------------------------- */
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) {
    return { container: 'flac', confidence: 'definite' };
  }

  /* --- MP3: ID3 tag, or a bare MPEG frame sync ------------------------ */
  if (startsWith(bytes, [0x49, 0x44, 0x33])) {
    // 'ID3' — an ID3v2 header. Could still be an ADTS file with an ID3 tag,
    // so a real parse should confirm, but for routing this is an MP3 family file.
    return { container: 'mp3', confidence: 'probable' };
  }
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    const layer = (bytes[1]! >> 1) & 0x03;
    // Layer bits 0b00 are reserved; ADTS AAC uses them, MPEG audio does not.
    if (layer === 0) return { container: 'adts', confidence: 'probable' };
    return { container: 'mp3', confidence: 'probable' };
  }

  return { container: 'unknown', confidence: 'unknown' };
}

/**
 * HEIC brands that hold a *sequence* rather than a single picture.
 *
 * They share a container with the stills but not a meaning, and nothing here decodes
 * them — `createImageBitmap` yields the first frame and says nothing about the rest, so
 * treating one as a still would silently export one frame of an animation. Reported as
 * unrecognised instead.
 */
export const HEIC_SEQUENCE_BRANDS: ReadonlySet<string> = new Set(['hevc', 'hevx', 'msf1']);

/**
 * Map an ISO-BMFF major brand to a container.
 *
 * MP4, MOV, M4A and HEIC are all the same container format — the brand is the only
 * thing separating them, which is exactly why extension-based detection fails here.
 */
function containerForBrand(brand: string): ContainerId {
  switch (brand) {
    case 'qt  ':
      return 'isobmff-mov';
    case 'M4A ':
    case 'M4B ':
      return 'isobmff-m4a';
    case 'heic':
    case 'heix':
    case 'hevc':
    case 'hevx':
    case 'mif1':
    case 'msf1':
      return 'isobmff-heic';
    default:
      // isom, iso2, mp41, mp42, avc1, dash, cmfc, … all mean "MP4 family".
      return 'isobmff-mp4';
  }
}

/**
 * Scan the EBML header for its DocType.
 *
 * The header is small and near the start, so a bounded linear scan is simpler and
 * more forgiving than a full EBML parser — and it never throws on truncated input.
 */
function findEbmlDocType(bytes: Uint8Array): string | undefined {
  // DocType element id is 0x4282, followed by a VINT size, then the ASCII value.
  for (let i = 4; i < Math.min(bytes.length - 3, 512); i++) {
    if (bytes[i] === 0x42 && bytes[i + 1] === 0x82) {
      const sizeByte = bytes[i + 2]!;
      // A 1-byte VINT has its high bit set; length is the low 7 bits.
      if ((sizeByte & 0x80) === 0) continue;
      const len = sizeByte & 0x7f;
      if (len === 0 || len > 16 || i + 3 + len > bytes.length) continue;
      const value = ascii(bytes, i + 3, len);
      if (/^[\x20-\x7e]+$/.test(value)) return value;
    }
  }
  return undefined;
}

/** Does a PNG carry an `acTL` chunk, making it animated? */
export function isApng(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
  // Walk the chunk list looking for `acTL`, which must precede the first `IDAT`.
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len =
      ((bytes[off]! << 24) | (bytes[off + 1]! << 16) | (bytes[off + 2]! << 8) | bytes[off + 3]!) >>>
      0;
    const type = ascii(bytes, off + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false; // acTL must come first
    off += 12 + len; // length + type + data + crc
    if (len > bytes.length) break; // malformed; stop rather than loop forever
  }
  return false;
}

/** Does a RIFF WebP carry an `ANIM` chunk, making it animated? */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) || ascii(bytes, 8, 4) !== 'WEBP') return false;
  // Chunks start at 12: [fourcc:4][size:4][payload]. The size is little-endian and
  // padded to an even boundary.
  let off = 12;
  while (off + 8 <= bytes.length) {
    const type = ascii(bytes, off, 4);
    const size =
      (bytes[off + 4]! | (bytes[off + 5]! << 8) | (bytes[off + 6]! << 16) | (bytes[off + 7]! << 24)) >>>
      0;
    if (type === 'ANIM') return true;
    if (type === 'ANMF') return true; // an animation frame implies animation
    if (type === 'VP8 ' || type === 'VP8L' || type === 'VP8X') {
      // These can precede ANIM in the extended format, so keep walking.
    }
    off += 8 + size + (size % 2);
    if (size > bytes.length) break; // malformed; stop rather than loop forever
  }
  return false;
}

/**
 * Count the frames in a GIF.
 *
 * A GIF is a block stream, so this walks it properly rather than scanning for byte
 * values — `0x2C` and `0x21` occur constantly inside compressed image data, and a naive
 * count would report almost any GIF as animated.
 */
export function countGifFrames(bytes: Uint8Array): number {
  if (!startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 0;

  let off = 6;
  if (off + 7 > bytes.length) return 0;

  const packed = bytes[off + 4]!;
  off += 7; // logical screen descriptor

  const hasGlobalTable = (packed & 0x80) !== 0;
  if (hasGlobalTable) off += 3 * (1 << ((packed & 0x07) + 1));

  let frames = 0;

  // Skip a chain of sub-blocks: [size:1][data:size]…, terminated by a zero size.
  const skipSubBlocks = (start: number): number => {
    let p = start;
    while (p < bytes.length) {
      const size = bytes[p]!;
      p += 1 + size;
      if (size === 0) break;
    }
    return p;
  };

  while (off < bytes.length) {
    const introducer = bytes[off]!;

    if (introducer === 0x3b) break; // trailer

    if (introducer === 0x21) {
      // Extension: [0x21][label][sub-blocks…]
      off = skipSubBlocks(off + 2);
      continue;
    }

    if (introducer === 0x2c) {
      frames += 1;
      if (off + 10 > bytes.length) break;
      const localPacked = bytes[off + 9]!;
      let p = off + 10;
      if ((localPacked & 0x80) !== 0) p += 3 * (1 << ((localPacked & 0x07) + 1)); // local table
      p += 1; // LZW minimum code size
      off = skipSubBlocks(p);
      continue;
    }

    // Unknown introducer: the stream is malformed. Stop rather than guess.
    break;
  }

  return frames;
}

/** Is this GIF more than a single frame? */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  return countGifFrames(bytes) > 1;
}

/**
 * Does this image carry transparency?
 *
 * Without this, converting a transparent PNG to JPEG produces no warning at all — and
 * that is a `critical` loss the user cannot undo. Detection is per-format because each
 * stores the flag somewhere different.
 *
 * Returns `false` for formats that cannot carry alpha at all (JPEG), so the caller can
 * treat the answer as final rather than "unknown".
 */
export function imageHasAlpha(bytes: Uint8Array, container: ContainerId): boolean {
  switch (container) {
    case 'jpeg':
      return false;

    case 'png': {
      // IHDR is the first chunk: 8 signature + 4 length + 4 type, so its data starts
      // at 16. The colour type is the 10th byte of that data.
      const colourType = bytes[25];
      // 4 = greyscale + alpha, 6 = truecolour + alpha. Palette images (3) can also be
      // transparent, via a tRNS chunk, which we check for separately.
      if (colourType === 4 || colourType === 6) return true;
      if (colourType === 3) return hasChunk(bytes, 'tRNS');
      return hasChunk(bytes, 'tRNS');
    }

    case 'gif':
      // Only for single-frame GIFs, and deliberately so.
      //
      // Animated GIFs routinely set the transparent-colour flag for *frame deltas* —
      // "this pixel is unchanged from the previous frame" — so a fully opaque animation
      // still declares transparency. Measured on this project's own fixture: ffmpeg's
      // 10-frame `testsrc` GIF sets the flag on 9 of its 10 control extensions while
      // containing no transparent pixel at all.
      //
      // Warning about lost transparency there would be a false alarm, and warning fatigue
      // is what makes users stop reading the warnings that matter. A still GIF, by
      // contrast, has no deltas to encode, so a transparent index in one is real.
      return countGifFrames(bytes) <= 1 && gifHasTransparency(bytes);

    case 'webp':
      return webpHasAlpha(bytes);

    case 'isobmff-heic':
      // HEIC can carry an alpha auxiliary image, but the flag is not in the `ftyp` or any
      // other fixed offset — it lives behind a set of `meta` box references that would
      // mean a real parse. Answered `false` rather than guessed at, which under-reports
      // rather than raising a warning about transparency that may not exist.
      return false;

    default:
      return false;
  }
}

/** Walk a PNG's chunk list looking for a given chunk type. */
function hasChunk(bytes: Uint8Array, wanted: string): boolean {
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len =
      ((bytes[off]! << 24) | (bytes[off + 1]! << 16) | (bytes[off + 2]! << 8) | bytes[off + 3]!) >>>
      0;
    const type = ascii(bytes, off + 4, 4);
    if (type === wanted) return true;
    if (type === 'IDAT' && wanted !== 'tRNS') return false;
    if (len > bytes.length) break;
    off += 12 + len;
  }
  return false;
}

/** Scan a GIF's blocks for a graphic control extension with the transparency flag set. */
function gifHasTransparency(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return false;

  let off = 6;
  if (off + 7 > bytes.length) return false;
  const packed = bytes[off + 4]!;
  off += 7;
  if ((packed & 0x80) !== 0) off += 3 * (1 << ((packed & 0x07) + 1));

  while (off < bytes.length) {
    const introducer = bytes[off]!;
    if (introducer === 0x3b) break; // trailer

    if (introducer === 0x21) {
      const label = bytes[off + 1];
      // 0xF9 is the graphic control extension: [0x21][0xF9][size=4][flags]…
      if (label === 0xf9 && bytes[off + 3] !== undefined && (bytes[off + 3]! & 0x01) !== 0) {
        return true;
      }
      let p = off + 2;
      while (p < bytes.length) {
        const size = bytes[p]!;
        p += 1 + size;
        if (size === 0) break;
      }
      off = p;
      continue;
    }

    if (introducer === 0x2c) {
      if (off + 10 > bytes.length) break;
      const localPacked = bytes[off + 9]!;
      let p = off + 10;
      if ((localPacked & 0x80) !== 0) p += 3 * (1 << ((localPacked & 0x07) + 1));
      p += 1;
      while (p < bytes.length) {
        const size = bytes[p]!;
        p += 1 + size;
        if (size === 0) break;
      }
      off = p;
      continue;
    }

    break;
  }
  return false;
}

/** WebP keeps its alpha flag in the extended-format header, or inside a VP8L stream. */
function webpHasAlpha(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) || ascii(bytes, 8, 4) !== 'WEBP') return false;

  const fourcc = ascii(bytes, 12, 4);

  if (fourcc === 'VP8X') {
    // [fourcc][size][flags:1]… — bit 4 (0x10) is the alpha flag.
    return ((bytes[20] ?? 0) & 0x10) !== 0;
  }
  if (fourcc === 'VP8L') {
    // Lossless streams carry a 5-bit header where bit 4 of the first byte after the
    // signature indicates alpha.
    const b = bytes[21];
    return b === undefined ? false : (b & 0x10) !== 0;
  }
  // `VP8 ` (simple lossy) has no alpha channel.
  return false;
}
