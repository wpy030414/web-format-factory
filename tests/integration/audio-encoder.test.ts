import { describe, expect, it } from 'vitest';
import { canEncodeAudio } from 'mediabunny';

import { hasExtension, primeAudioEncoder } from '@/engines/mediabunny/extensions.ts';

/**
 * The audio encoder extensions.
 *
 * WebCodecs has no MP3 or FLAC encoder on any platform and no AAC encoder on several, so
 * without these packages three of the six audio targets are advertised and then refused.
 * What is asserted here is the mechanism that closes that gap: registering the extension
 * is what flips the engine's own capability answer.
 *
 * These run in Node, where *nothing* is natively encodable — which makes it an unusually
 * clean place to test the fallback, because every answer has to come from the extension
 * or from an honest refusal. The artifact itself (a real MP3 that ffprobe reads back) is
 * asserted in the end-to-end suite, where the encoders actually run.
 */
describe('音频编码器扩展', () => {
  it('注册之后，引擎才承认自己会编 MP3', async () => {
    expect(await canEncodeAudio('mp3')).toBe(false);
    expect(hasExtension('mp3')).toBe(true);

    const chosen = await primeAudioEncoder({ codecs: ['mp3'] });

    expect(chosen).toBe('mp3');
    // Registration invalidates the capability memo, so this is the post-registration
    // truth rather than a cached "no".
    expect(await canEncodeAudio('mp3')).toBe(true);
  });

  it('用户点名的编码做不到时，如实报告而不是偷偷换一个', async () => {
    // Vorbis has no extension package and no native encoder. The honest answer is that
    // nothing here can produce it, which is what lets the dispatcher hand the job to
    // another engine instead of quietly substituting something else.
    const chosen = await primeAudioEncoder({ codecs: ['vorbis', 'opus'], requested: 'vorbis' });

    expect(chosen).toBeNull();
    // Opus is not offered as a consolation prize when Vorbis was asked for by name.
    expect(chosen).not.toBe('opus');
  });

  it('用户没有点名时，会沿着容器的编码列表往下找到能用的那个', async () => {
    // Self-contained rather than leaning on the test above having run first: FLAC is the
    // one in this list with an extension behind it, so the walk has to skip Vorbis and
    // stop at FLAC.
    const chosen = await primeAudioEncoder({ codecs: ['vorbis', 'flac'] });

    expect(chosen).toBe('flac');
  });

  it('容器一个音频编码都不支持时不下载任何东西', async () => {
    // A container with no audio at all — asking for an encoder for it would be a
    // megabyte spent on nothing.
    expect(await primeAudioEncoder({ codecs: [] })).toBeNull();
  });
});
