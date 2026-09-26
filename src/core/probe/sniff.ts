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
