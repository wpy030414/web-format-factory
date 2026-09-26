/**
 * Build the Live Photo fixtures.
 *
 * Run after `scripts/gen-fixtures.sh`, which produces the still and video halves:
 *
 *   pnpm fixtures
 *
 * These fixtures are produced by this project's own packager, which is a real
 * limitation: it means the round-trip tests cannot catch a misunderstanding shared
 * between the packer and the detector. The unit tests compensate by asserting the
 * documented byte-level properties directly — that `MicroVideoOffset` equals the video
 * length, that the offset lands on a video container, that other tools' conventions
 * (both the modern and legacy XMP forms) are present — rather than only checking that
 * our own reader agrees with our own writer.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildLivp, buildMotionPhoto } from '../src/livephoto/pack.ts';
import { writeXmp } from '../src/livephoto/xmp.ts';

const DIR = join(process.cwd(), 'tests/fixtures/generated');
const read = (name: string) => new Uint8Array(readFileSync(join(DIR, name)));
const write = (name: string, bytes: Uint8Array) => {
  writeFileSync(join(DIR, name), bytes);
  console.log(`  ${name.padEnd(22)} ${bytes.length} bytes`);
};

console.log('Live Photo fixtures:');

// --- a Google Motion Photo: the still with the video appended -----------------
write('motionphoto.jpg', buildMotionPhoto(read('still.jpg'), read('av.mp4'), {
  presentationTimestampUs: 0,
}).bytes);

// --- an Apple pair packaged as .livp ------------------------------------------
write('pair.livp', buildLivp(read('still.jpg'), read('av.mov')).bytes);

/**
 * A pair whose two halves share Apple's identifier.
 *
 * The video is tagged with native ffmpeg here rather than through the app, so the
 * fixture is not produced by the same code path that the test then exercises. The still
 * carries the same value in its XMP, which is where a JPEG Live Photo keeps it.
 */
const UUID = 'A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D';

execFileSync('ffmpeg', [
  '-v', 'error',
  '-i', join(DIR, 'av.mov'),
  '-c', 'copy',
  // Mandatory: without it the tag is written where ffprobe cannot read it back, and
  // nothing reports an error. See docs/DECISIONS.md ADR-004.
  '-movflags', 'use_metadata_tags',
  '-metadata', `com.apple.quicktime.content.identifier=${UUID}`,
  join(DIR, 'pair-tagged.mov'),
  '-y',
]);

write(
  'pair-tagged.jpg',
  writeXmp(
    read('still.jpg'),
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:apple="http://ns.apple.com/maf/1.0/" apple:ContentIdentifier="${UUID}"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`,
  ),
);

console.log(`\n  the two "pair-tagged.*" fixtures share identifier ${UUID.slice(0, 8)}…`);
console.log('  "still.jpg" + "av.mov" are an untagged pair, matched by filename');
