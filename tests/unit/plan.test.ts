import { describe, expect, it } from 'vitest';
import type { MediaProfile } from '@/core/probe/profile.ts';
import { planFor } from '@/core/routing/resolve.ts';
import type { RouteCapabilities } from '@/core/routing/gates.ts';
import { pickDefaultTarget } from '@/state/store.ts';
import type { FormatId } from '@/core/types.ts';

/**
 * Every route open.
 *
 * These tests are about what the routing table and the loss model *mean*, not about what
 * this machine happens to be able to run — the capability gates have their own file. The
 * optimistic set is passed explicitly rather than defaulted inside `planFor`, so which
 * question a test is asking is visible at the call site.
 */
const CAPS: RouteCapabilities = { imageDecoder: true, crossOriginIsolated: true };

/** Build a minimal profile for a container with the given codecs. */
function profileWith(
  mediaClass: MediaProfile['mediaClass'],
  opts: { video?: string[]; audio?: string[]; container?: MediaProfile['container'] } = {},
): MediaProfile {
  return {
    name: 'x',
    size: 1,
    container: opts.container ?? 'isobmff-mp4',
    mediaClass,
    videoTracks: (opts.video ?? []).map((codec) => ({
      codec,
      width: 1920,
      height: 1080,
      decodable: true,
    })),
    audioTracks: (opts.audio ?? []).map((codec) => ({
      codec,
      channels: 2,
      sampleRate: 44100,
      decodable: true,
    })),
    otherTrackCount: 0,
  };
}

describe('planFor — 诚实性：无损与有损必须由编码决定', () => {
  it('MP3 → M4A 是有损的，尽管两者都是「直接接受」', () => {
    // The bug this guards against: a `direct` verdict was read as "the payload is
    // preserved". AAC cannot store MP3 frames, so this must re-encode — calling it
    // lossless would tell the user a lossy conversion costs nothing.
    const plan = planFor(
      profileWith('audio', { audio: ['mp3'], container: 'mp3' }),
      'm4a',
      CAPS,
    );
    expect(plan.feasible).toBe(true);
    expect(plan.fidelity).toBe('lossy');
    expect(plan.did).toBe('transcode');
  });

  it('WAV → FLAC 必须重新编码', () => {
    const plan = planFor(
      profileWith('audio', { audio: ['pcm'], container: 'wav' }),
      'flac',
      CAPS,
    );
    expect(plan.did).toBe('transcode');
  });

  it('MP4 → MKV 是换容器，无损且瞬时', () => {
    const plan = planFor(
      profileWith('video', { video: ['avc'], audio: ['aac'] }),
      'mkv',
      CAPS,
    );
    expect(plan.fidelity).toBe('lossless');
    expect(plan.did).toBe('transmux');
  });

  it('MP4 → MOV 是换容器', () => {
    const plan = planFor(
      profileWith('video', { video: ['avc'], audio: ['aac'] }),
      'mov',
      CAPS,
    );
    expect(plan.did).toBe('transmux');
  });

  it('MP4 → WebM 必须重新编码（H.264 装不进 WebM）', () => {
    const plan = planFor(
      profileWith('video', { video: ['avc'], audio: ['aac'] }),
      'webm',
      CAPS,
    );
    expect(plan.did).toBe('transcode');
    expect(plan.fidelity).toBe('lossy');
  });

  it('只要有一条轨道装不进，整体就必须重新编码', () => {
    // Checking only the first codec would call this a copy and silently re-encode the
    // audio, or worse, drop it.
    const plan = planFor(
      profileWith('video', { video: ['avc'], audio: ['opus'] }),
      'mov', // MOV holds avc + aac/pcm, not Opus
      CAPS,
    );
    expect(plan.did).toBe('transcode');
  });

  it('MP4 → MP4 同容器同编码是换容器', () => {
    const plan = planFor(
      profileWith('video', { video: ['avc'], audio: ['aac'] }),
      'mp4',
      CAPS,
    );
    expect(plan.did).toBe('transmux');
  });

  it('显式选择的编码会覆盖可复制的判断', () => {
    // `codec` is a real control on the Matroska target, so choosing VP9 there is a
    // decision the user can actually make.
    const plan = planFor(
      profileWith('video', { video: ['avc'], audio: ['aac'] }),
      'mkv',
      CAPS,
      { codec: 'vp9' },
    );
    expect(plan.did).toBe('transcode');
  });

  it('停在默认值上的参数不算一次选择', () => {
    // The panel seeds every control with its declared default, so `codec` is always
    // *present*. Reading presence as a choice marked every untouched conversion as a
    // re-encode — turning a free, lossless container change into a generation loss.
    const defaulted = planFor(
      profileWith('video', { video: ['avc'], audio: ['aac'] }),
      'mkv',
      CAPS,
      { codec: 'avc' }, // Matroska's declared default
    );
    expect(defaulted.did).toBe('transmux');
    expect(defaulted.fidelity).toBe('lossless');
  });

  it('目标格式根本不暴露的参数会被忽略，而不是误当成指令', () => {
    // Matroska has no quality control, so a stray quality value is not something the
    // user could have meant — it must not silently force a re-encode.
    const plan = planFor(
      profileWith('video', { video: ['avc'], audio: ['aac'] }),
      'mkv',
      CAPS,
      { quality: 80 },
    );
    expect(plan.did).toBe('transmux');
  });
});

describe('planFor — 不可能转换', () => {
  it('音频对视频目标不可行，并给出可执行的归因', () => {
    const plan = planFor(
      profileWith('audio', { audio: ['mp3'], container: 'mp3' }),
      'mp4',
      CAPS,
    );
    expect(plan.feasible).toBe(false);
    expect(plan.impossibility?.reason).toBe('needs-visual-component');
    // The alternatives must be real, usable targets — a dead end is not a reason.
    expect(plan.impossibility?.alternatives).toContain('mp3' as FormatId);
    expect(plan.impossibility?.alternatives).not.toContain('mp4' as FormatId);
  });

  it('静图对动图目标不可行', () => {
    const plan = planFor(profileWith('still-image', { container: 'png' }), 'gif', CAPS);
    expect(plan.feasible).toBe(false);
    expect(plan.impossibility?.reason).toBe('needs-multiple-frames');
  });

  it('不设损失的转换不会要求确认', () => {
    const plan = planFor(
      profileWith('video', { video: ['avc'], audio: ['aac'] }),
      'mkv',
      CAPS,
    );
    expect(plan.needsAcknowledgement).toBe(false);
  });
});

describe('planFor — 两种 Live Photo 形态', () => {
  it('视频对两种形态都可行，且都如实标为投影', () => {
    const profile = profileWith('video', { video: ['avc'], audio: ['aac'] });

    for (const target of ['live-photo', 'motion-photo'] as FormatId[]) {
      const plan = planFor(profile, target, CAPS);
      expect(plan.feasible, target).toBe(true);
      // A bundle is not what went in, whatever else is true of it.
      expect(plan.fidelity, target).toBe('projection');
    }
  });

  it('Live Photo 转 Motion Photo 可行——把一个包换成另一种形状', () => {
    const plan = planFor(profileWith('live-photo', { container: 'zip' }), 'motion-photo', CAPS);
    expect(plan.feasible).toBe(true);
    expect(plan.fidelity).toBe('projection');
  });

  it('动图对两种形态都可行——一段帧序列本来就同时具备两半', () => {
    // A GIF is not a photograph, but it is not a still image either: it has a first
    // frame for one half and a real frame sequence for the other. Refusing this would
    // have meant calling impossible something whose every ingredient is already here.
    for (const container of ['gif', 'webp', 'png'] as MediaProfile['container'][]) {
      for (const target of ['live-photo', 'motion-photo'] as FormatId[]) {
        const plan = planFor(profileWith('animated-image', { container }), target, CAPS);
        expect(plan.feasible, `${container} → ${target}`).toBe(true);
        expect(plan.verdict.kind, `${container} → ${target}`).toBe('project');
        expect(plan.fidelity, `${container} → ${target}`).toBe('projection');
      }
    }
  });

  it('静图对两种形态都不可行，理由是缺视频那一半', () => {
    // The same refusal for both flavours, because the reason is the same: inventing the
    // motion half would be creation, not conversion.
    const profile = profileWith('still-image', { container: 'jpeg' });

    for (const target of ['live-photo', 'motion-photo'] as FormatId[]) {
      const plan = planFor(profile, target, CAPS);
      expect(plan.feasible, target).toBe(false);
      expect(plan.impossibility?.reason, target).toBe('livephoto-needs-video');
    }
  });

  it('默认目标不会挑中这两种形态', () => {
    // Deliberate destinations, not somewhere to be steered: a video's default should be
    // the plain container change.
    const profile = profileWith('video', { video: ['avc'], audio: ['aac'] });
    expect(pickDefaultTarget(profile, CAPS)).not.toBe('motion-photo');
    expect(pickDefaultTarget(profile, CAPS)).not.toBe('live-photo');
  });
});

describe('pickDefaultTarget — 默认动作应当是免费的那个', () => {
  it('视频默认选换容器的目标，而不是需要转码的', () => {
    // WebM is a plausible-looking default but forces H.264 → VP9: slow and lossy.
    // MKV holds H.264/AAC as-is, so it is the better default.
    const profile = profileWith('video', { video: ['avc'], audio: ['aac'] });
    expect(pickDefaultTarget(profile, CAPS)).toBe('mkv');
  });

  it('从不默认选源文件已有的格式', () => {
    const asMkv = profileWith('video', {
      video: ['avc'],
      audio: ['aac'],
      container: 'matroska',
    });
    expect(pickDefaultTarget(asMkv, CAPS)).not.toBe('mkv');
  });

  it('HEIC 默认给 JPEG：手机拍出来的照片得有个地方可去', () => {
    // HEIC shares its container with MP4, and the comparison that decides "is this the
    // format we are already in" has to go through the format's declared containers
    // rather than its id — `'jpeg'` and `'isobmff-heic'` are different vocabularies and
    // could never be equal.
    const profile = profileWith('still-image', { container: 'isobmff-heic' });
    const picked = pickDefaultTarget(profile, CAPS);

    expect(picked).toBe('jpeg');
    expect(planFor(profile, picked!, CAPS).feasible).toBe(true);
  });

  it('没有免费目标时，退回第一个可行的', () => {
    // MP3 frames can only live in an MP3 container among the audio preferences, so
    // every remaining option is a transcode — the default must still be usable.
    const profile = profileWith('audio', { audio: ['mp3'], container: 'mp3' });
    const picked = pickDefaultTarget(profile, CAPS);
    expect(picked).not.toBeNull();
    expect(planFor(profile, picked!, CAPS).feasible).toBe(true);
  });

  it('什么都不可行时返回 null，而不是给一个会失败的按钮', () => {
    const profile = profileWith('unknown', { container: 'unknown' });
    expect(pickDefaultTarget(profile, CAPS)).toBeNull();
  });
});
