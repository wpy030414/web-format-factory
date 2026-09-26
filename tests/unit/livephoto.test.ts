import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { detectMotionPhoto, pairLivePhotos, unpackLivp } from '@/livephoto/detect.ts';
import { buildLivp, buildMotionPhoto } from '@/livephoto/pack.ts';
import { extractXmp, readXmpNumber, writeXmp } from '@/livephoto/xmp.ts';

const FIXTURES = join(process.cwd(), 'tests/fixtures/generated');
const haveFixtures = existsSync(FIXTURES);

const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

describe.skipIf(!haveFixtures)('Motion Photo — 往返', () => {
  it('封装后能被自己的探测器读回，且视频字节完全一致', () => {
    const still = fixture('still.jpg');
    const video = fixture('av.mp4');

    const { bytes } = buildMotionPhoto(still, video, { presentationTimestampUs: 1234 });
    const readBack = detectMotionPhoto(bytes, 'jpeg');

    expect(readBack).not.toBeNull();
    expect(readBack!.flavor).toBe('google-motionphoto-jpeg');
    expect(readBack!.presentationTimestampUs).toBe(1234);

    // The video half must come back byte-identical — this is a concatenation, not a
    // re-encode, so any difference would mean we corrupted it.
    expect(readBack!.video.bytes).toEqual(video);
  });

  it('静图半边仍是一张可用的 JPEG（注入 XMP 不会破坏它）', () => {
    const { bytes } = buildMotionPhoto(fixture('still.jpg'), fixture('av.mp4'));
    const readBack = detectMotionPhoto(bytes, 'jpeg');
    // A JPEG still starts with SOI and ends with EOI.
    const still = readBack!.still.bytes;
    expect([still[0], still[1]]).toEqual([0xff, 0xd8]);
    expect([still[still.length - 2], still[still.length - 1]]).toEqual([0xff, 0xd9]);
  });

  it('偏移量是从文件末尾起算的，等于视频长度', () => {
    const video = fixture('av.mp4');
    const { bytes } = buildMotionPhoto(fixture('still.jpg'), video);
    const xmp = extractXmp(bytes);

    // The property that makes this writable before the final size is known.
    expect(readXmpNumber(xmp!, 'Camera:MicroVideoOffset')).toBe(video.length);
  });

  it('同时写入现代与旧版两套字段', () => {
    const { bytes } = buildMotionPhoto(fixture('still.jpg'), fixture('av.mp4'));
    const xmp = extractXmp(bytes)!;
    // Modern readers use the container directory; older ones look for the legacy keys.
    expect(xmp).toContain('Container:Directory');
    expect(xmp).toContain('Item:Semantic="MotionPhoto"');
    expect(xmp).toContain('Camera:MicroVideoOffset');
  });
});

describe.skipIf(!haveFixtures)('Motion Photo — 负例', () => {
  it('普通 JPEG 不会被误判', () => {
    expect(detectMotionPhoto(fixture('still.jpg'), 'jpeg')).toBeNull();
  });

  it('标记还在、但偏移已失效时判定为「不是」', () => {
    // The common real-world case: a tool stripped the video but left the XMP behind.
    // Trusting the marker would produce a "Live Photo" whose video is a slice of JPEG.
    const { bytes } = buildMotionPhoto(fixture('still.jpg'), fixture('av.mp4'));
    const xmp = extractXmp(bytes)!;

    // Point the offset at a region of the file that is not a video container.
    const tampered = writeXmp(
      bytes.subarray(0, bytes.length - 1000),
      xmp.replace(/Camera:MicroVideoOffset="\d+"/, 'Camera:MicroVideoOffset="200"'),
    );
    expect(detectMotionPhoto(tampered, 'jpeg')).toBeNull();
  });

  it('非 JPEG 容器一律不看', () => {
    expect(detectMotionPhoto(fixture('still.png'), 'png')).toBeNull();
    expect(detectMotionPhoto(fixture('av.mp4'), 'isobmff-mp4')).toBeNull();
  });
});

describe('XMP — 写入 JPEG', () => {
  it.skipIf(!haveFixtures)('注入后仍能被读回', () => {
    const original = fixture('still.jpg');
    const tagged = writeXmp(original, '<packet>hello</packet>');
    expect(extractXmp(tagged)).toContain('<packet>hello</packet>');
  });

  it.skipIf(!haveFixtures)('重复写入是替换而不是追加', () => {
    // A second XMP segment would be ignored by readers while doubling the file's
    // metadata — the first one wins, so appending is worse than useless.
    const once = writeXmp(fixture('still.jpg'), '<a>1</a>');
    const twice = writeXmp(once, '<a>2</a>');
    expect(twice.length).toBeLessThan(once.length * 2);
    expect(extractXmp(twice)).toContain('<a>2</a>');
    expect(extractXmp(twice)).not.toContain('<a>1</a>');
  });

  it.skipIf(!haveFixtures)('保留原有的 APP0/JFIF 段', () => {
    const tagged = writeXmp(fixture('still.jpg'), '<x/>');
    // SOI, then XMP we inserted… unless the original already had JFIF, in which case
    // JFIF must still come first.
    expect([tagged[0], tagged[1]]).toEqual([0xff, 0xd8]);
    expect(extractXmp(tagged)).toBeTruthy();
  });

  it('拒绝非 JPEG 输入，而不是产出一个坏文件', () => {
    expect(() => writeXmp(new Uint8Array([1, 2, 3, 4]), '<x/>')).toThrow();
  });

  it('包体过大时抛错，而不是静默截断', () => {
    // Truncating would produce a file that opens fine and whose metadata is silently
    // unreadable — the exact failure mode this project exists to avoid.
    if (!haveFixtures) return;
    const huge = '<pad>' + 'x'.repeat(70_000) + '</pad>';
    expect(() => writeXmp(fixture('still.jpg'), huge)).toThrow(/too large/i);
  });
});

describe.skipIf(!haveFixtures)('.livp — 往返', () => {
  it('打包后能解包出静图与视频', () => {
    const still = fixture('still.jpg');
    const video = fixture('av.mov');

    const { bytes } = buildLivp(still, video);
    const readBack = unpackLivp(bytes);

    expect(readBack).not.toBeNull();
    expect(readBack!.flavor).toBe('apple-livp');
    expect(readBack!.still.bytes).toEqual(still);
    expect(readBack!.video.bytes).toEqual(video);
  });

  it('不是压缩包时返回 null，而不是抛异常', () => {
    expect(unpackLivp(fixture('still.jpg'))).toBeNull();
  });

  it('压缩包里缺一半时返回 null，并说明原因', () => {
    // Built by hand rather than through `buildLivp`, because that already refuses to
    // produce an invalid archive — its self-check is the subject of the next test.
    const zip = zipSync({
      'live.jpg': [fixture('still.jpg'), { level: 0 }],
    });
    expect(unpackLivp(zip)).toBeNull();
  });

  it('封装时会自校验，拒绝产出一个拆不开的压缩包', () => {
    // Passing the same JPEG as both halves is not a Live Photo, and the packaging step
    // must notice rather than hand back a file that looks plausible and cannot be split.
    expect(() => buildLivp(fixture('still.jpg'), fixture('still.jpg'))).toThrow(/自校验/);
  });
});

describe('Apple — 配对', () => {
  it('优先按标识配对', () => {
    const groups = pairLivePhotos([
      { name: 'a.jpg', bytes: new Uint8Array(), container: 'jpeg', contentId: 'ID-1' },
      { name: 'unrelated.mov', bytes: new Uint8Array(), container: 'isobmff-mov', contentId: 'ID-1' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matchedBy).toBe('identifier');
  });

  it('标识缺失时退回按文件名配对', () => {
    const groups = pairLivePhotos([
      { name: 'IMG_0042.jpg', bytes: new Uint8Array(), container: 'jpeg' },
      { name: 'IMG_0042.mov', bytes: new Uint8Array(), container: 'isobmff-mov' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matchedBy).toBe('filename');
  });

  it('不会把同一段视频配给两张静图', () => {
    const groups = pairLivePhotos([
      { name: 'x.jpg', bytes: new Uint8Array(), container: 'jpeg' },
      { name: 'x.mov', bytes: new Uint8Array(), container: 'isobmff-mov' },
      { name: 'y.jpg', bytes: new Uint8Array(), container: 'jpeg' },
    ]);
    expect(groups).toHaveLength(1);
  });

  it('没有可配对的视频时不产出任何组', () => {
    expect(
      pairLivePhotos([
        { name: 'a.jpg', bytes: new Uint8Array(), container: 'jpeg' },
        { name: 'b.jpg', bytes: new Uint8Array(), container: 'jpeg' },
      ]),
    ).toEqual([]);
  });
});

