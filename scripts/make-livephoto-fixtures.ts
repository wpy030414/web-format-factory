/**
 * Build the Live Photo fixtures.
 *
 * Run after `scripts/gen-fixtures.sh`, which produces the still and video halves:
 *
 *   pnpm exec vite-node scripts/make-livephoto-fixtures.ts
 *
 * These fixtures are produced by this project's own packager, which is a real
 * limitation: it means the round-trip tests cannot catch a misunderstanding shared
 * between the packer and the detector. The unit tests compensate by asserting the
 * documented byte-level properties directly — that `MicroVideoOffset` equals the video
 * length, that the offset lands on a video container, that other tools' conventions
 * (both the modern and legacy XMP forms) are present — rather than only checking that
 * our own reader agrees with our own writer.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildLivp, buildMotionPhoto } from '../src/livephoto/pack.ts';

const DIR = join(process.cwd(), 'tests/fixtures/generated');
const read = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));

// A Google Motion Photo: the still with the video appended.
const motion = buildMotionPhoto(read('still.jpg'), read('av.mp4'), {
  presentationTimestampUs: 0,
});
writeFileSync(join(DIR, 'motionphoto.jpg'), motion.bytes);
console.log(`motionphoto.jpg      ${motion.bytes.length} bytes`);

// An Apple pair, packaged as a .livp.
const livp = buildLivp(read('still.jpg'), read('av.mov'));
writeFileSync(join(DIR, 'pair.livp'), livp.bytes);
console.log(`pair.livp            ${livp.bytes.length} bytes`);

// The same pair dropped as two loose files, which is how they arrive from most tools.
console.log('still.jpg + av.mov   already present as the loose pair');
