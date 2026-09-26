import { describe, expect, it } from 'vitest';
import type { MediaProfile } from '@/core/probe/profile.ts';
import { planFor } from '@/core/routing/resolve.ts';
import { pickDefaultTarget } from '@/state/store.ts';
import type { FormatId } from '@/core/types.ts';

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
    const plan = planFor(profileWith('audio', { audio: ['mp3'], container: 'mp3' }), 'm4a');
    expect(plan.feasible).toBe(true);
    expect(plan.fidelity).toBe('lossy');
    expect(plan.did).toBe('transcode');
  });

  it('WAV → FLAC 必须重新编码', () => {
    const plan = planFor(profileWith('audio', { audio: ['pcm'], container: 'wav' }), 'flac');
    expect(plan.did).toBe('transcode');
  });

  it('MP4 → MKV 是换容器，无损且瞬时', () => {
    const plan = planFor(profileWith('video', { video: ['avc'], audio: ['aac'] }), 'mkv');
    expect(plan.fidelity).toBe('lossless');
    expect(plan.did).toBe('transmux');
  });

  it('MP4 → MOV 是换容器', () => {
    const plan = planFor(profileWith('video', { video: ['avc'], audio: ['aac'] }), 'mov');
    expect(plan.did).toBe('transmux');
  });

  it('MP4 → WebM 必须重新编码（H.264 装不进 WebM）', () => {
    const plan = planFor(profileWith('video', { video: ['avc'], audio: ['aac'] }), 'webm');
    expect(plan.did).toBe('transcode');
    expect(plan.fidelity).toBe('lossy');
  });

  it('只要有一条轨道装不进，整体就必须重新编码', () => {
    // Checking only the first codec would call this a copy and silently re-encode the
    // audio, or worse, drop it.
    const plan = planFor(
      profileWith('video', { video: ['avc'], audio: ['opus'] }),
      'mov', // MOV holds avc + aac/pcm, not Opus
    );
    expect(plan.did).toBe('transcode');
  });

  it('MP4 → MP4 同容器同编码是换容器', () => {
    const plan = planFor(profileWith('video', { video: ['avc'], audio: ['aac'] }), 'mp4');
    expect(plan.did).toBe('transmux');
  });

  it('显式选择的编码会覆盖可复制的判断', () => {
    // `codec` is a real control on the Matroska target, so choosing VP9 there is a
    // decision the user can actually make.
    const plan = planFor(profileWith('video', { video: ['avc'], audio: ['aac'] }), 'mkv', {
      codec: 'vp9',
    });
    expect(plan.did).toBe('transcode');
  });

  it('停在默认值上的参数不算一次选择', () => {
    // The panel seeds every control with its declared default, so `codec` is always
    // *present*. Reading presence as a choice marked every untouched conversion as a
    // re-encode — turning a free, lossless container change into a generation loss.
    const defaulted = planFor(profileWith('video', { video: ['avc'], audio: ['aac'] }), 'mkv', {
      codec: 'avc', // Matroska's declared default
    });
    expect(defaulted.did).toBe('transmux');
    expect(defaulted.fidelity).toBe('lossless');
  });

  it('目标格式根本不暴露的参数会被忽略，而不是误当成指令', () => {
    // Matroska has no quality control, so a stray quality value is not something the
    // user could have meant — it must not silently force a re-encode.
    const plan = planFor(profileWith('video', { video: ['avc'], audio: ['aac'] }), 'mkv', {
      quality: 80,
    });
    expect(plan.did).toBe('transmux');
  });
});

describe('planFor — 不可能转换', () => {
  it('音频对视频目标不可行，并给出可执行的归因', () => {
    const plan = planFor(profileWith('audio', { audio: ['mp3'], container: 'mp3' }), 'mp4');
    expect(plan.feasible).toBe(false);
    expect(plan.impossibility?.reason).toBe('needs-visual-component');
    // The alternatives must be real, usable targets — a dead end is not a reason.
    expect(plan.impossibility?.alternatives).toContain('mp3' as FormatId);
    expect(plan.impossibility?.alternatives).not.toContain('mp4' as FormatId);
  });

  it('静图对动图目标不可行', () => {
    const plan = planFor(profileWith('still-image', { container: 'png' }), 'gif');
    expect(plan.feasible).toBe(false);
    expect(plan.impossibility?.reason).toBe('needs-multiple-frames');
  });

  it('不设损失的转换不会要求确认', () => {
    const plan = planFor(profileWith('video', { video: ['avc'], audio: ['aac'] }), 'mkv');
    expect(plan.needsAcknowledgement).toBe(false);
  });
});

describe('pickDefaultTarget — 默认动作应当是免费的那个', () => {
  it('视频默认选换容器的目标，而不是需要转码的', () => {
    // WebM is a plausible-looking default but forces H.264 → VP9: slow and lossy.
    // MKV holds H.264/AAC as-is, so it is the better default.
    const profile = profileWith('video', { video: ['avc'], audio: ['aac'] });
    expect(pickDefaultTarget(profile)).toBe('mkv');
  });

  it('从不默认选源文件已有的格式', () => {
    const asMkv = profileWith('video', {
      video: ['avc'],
      audio: ['aac'],
      container: 'matroska',
    });
    expect(pickDefaultTarget(asMkv)).not.toBe('mkv');
  });

  it('没有免费目标时，退回第一个可行的', () => {
    // MP3 frames can only live in an MP3 container among the audio preferences, so
    // every remaining option is a transcode — the default must still be usable.
    const profile = profileWith('audio', { audio: ['mp3'], container: 'mp3' });
    const picked = pickDefaultTarget(profile);
    expect(picked).not.toBeNull();
    expect(planFor(profile, picked!).feasible).toBe(true);
  });

  it('什么都不可行时返回 null，而不是给一个会失败的按钮', () => {
    const profile = profileWith('unknown', { container: 'unknown' });
    expect(pickDefaultTarget(profile)).toBeNull();
  });
});
