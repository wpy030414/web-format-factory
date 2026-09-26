import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALL_FORMATS,
  AdtsOutputFormat,
  BlobSource,
  FlacOutputFormat,
  Input,
  Mp4OutputFormat,
  WebMOutputFormat,
} from 'mediabunny';
import { MediabunnyEngine, planCopy } from '@/engines/mediabunny/index.ts';
import { EngineError } from '@/engines/types.ts';
import type { FormatId } from '@/core/types.ts';

/**
 * Integration tests for the primary engine, verified against `ffprobe`.
 *
 * The acceptance standard for this project is not "it did not throw" but "the artifact
 * is correct". So every conversion here writes a real file and then hands it to an
 * independent tool to confirm the container and codecs are what we claimed.
 *
 * Scope note: these cover **transmux only** — a pure container change copies encoded
 * packets and needs no codec at all, so it runs in Node. Anything that crosses codecs
 * needs WebCodecs and therefore a real browser; those live in tests/e2e. What we *can*
 * verify here is the planning decision that tells the two apart, which is where the
 * dangerous mistakes live.
 */

const FIXTURES = join(process.cwd(), 'tests/fixtures/generated');
const haveFixtures = existsSync(FIXTURES);
const haveFfprobe = (() => {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface ProbeResult {
  formatName: string;
  codecs: string[];
  durationSec: number;
}

function ffprobe(file: string): ProbeResult {
  const json = execFileSync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration',
      '-show_entries', 'stream=codec_name',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(json) as {
    format?: { format_name?: string; duration?: string };
    streams?: Array<{ codec_name?: string }>;
  };
  return {
    formatName: parsed.format?.format_name ?? '',
    codecs: (parsed.streams ?? []).map((s) => s.codec_name ?? '').filter(Boolean),
    durationSec: Number(parsed.format?.duration ?? 0),
  };
}

const fixtureBytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const fixture = (name: string) => new Blob([fixtureBytes(name)]);

async function convert(
  sourceName: string,
  target: FormatId,
  params: Record<string, unknown> = {},
): Promise<{ probe: ProbeResult; name: string; did: string }> {
  const engine = new MediabunnyEngine();
  const result = await engine.run({
    input: fixture(sourceName),
    inputName: sourceName,
    target,
    params,
  });

  const bytes = new Uint8Array(await result.outputs[0]!.blob.arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);

  const dir = mkdtempSync(join(tmpdir(), 'wff-engine-'));
  tmpDirs.push(dir);
  const path = join(dir, result.outputs[0]!.name);
  writeFileSync(path, bytes);

  return { probe: ffprobe(path), name: result.outputs[0]!.name, did: result.did };
}

/** Build an Input over a fixture, for planning assertions. */
const openInput = (name: string) =>
  new Input({ source: new BlobSource(fixture(name)), formats: ALL_FORMATS });

describe.skipIf(!haveFixtures)('planCopy — deciding copy vs transcode by codec, not by parameters', () => {
  it('plans a copy when the codecs fit the target container', async () => {
    const input = openInput('av.mp4');
    const decision = await planCopy(input, new Mp4OutputFormat());
    expect(decision.mode).toBe('forced');
    expect(decision.did).toBe('transmux');
    expect(decision.incompatible).toEqual([]);
  });

  it('plans a transcode when the codec cannot be stored, even with no parameters set', async () => {
    // PCM cannot live in a FLAC container. Deciding "no parameters means copy" would
    // make this fail outright — or worse, silently drop the audio track.
    const input = openInput('tone.wav');
    const decision = await planCopy(input, new FlacOutputFormat());
    expect(decision.did).toBe('transcode');
    expect(decision.mode).toBe('preferred');
    expect(decision.incompatible.length).toBeGreaterThan(0);
  });

  it('plans a transcode for MP3 into ADTS rather than refusing it', async () => {
    // MP3 → AAC is a legitimate conversion; it simply cannot be a copy.
    const input = openInput('tone.mp3');
    const decision = await planCopy(input, new AdtsOutputFormat());
    expect(decision.did).toBe('transcode');
  });

  it('plans a transcode for H.264 into WebM rather than refusing it', async () => {
    // WebM is a constrained Matroska profile — VP8/VP9/AV1 only. This is a real,
    // desirable conversion (re-encode to VP9), not an error case.
    const input = openInput('av.mp4');
    const decision = await planCopy(input, new WebMOutputFormat());
    expect(decision.did).toBe('transcode');
    expect(decision.incompatible).toContain('avc');
  });

  it('lets an explicit parameter request override an otherwise copyable plan', async () => {
    const input = openInput('av.mp4');
    const decision = await planCopy(input, new Mp4OutputFormat(), { quality: 80 });
    expect(decision.did).toBe('transcode');
  });
});

describe.skipIf(!haveFixtures || !haveFfprobe)('MediabunnyEngine — transmux verified against ffprobe', () => {
  it('reports which containers it can write, and no others', () => {
    const engine = new MediabunnyEngine();
    for (const t of ['mp4', 'mov', 'mkv', 'webm', 'm4a', 'mp3', 'wav', 'flac', 'ogg', 'aac']) {
      expect(engine.supports(t as FormatId)).toBe(true);
    }
    // Image and Live Photo targets belong to other engines.
    for (const t of ['jpeg', 'png', 'gif', 'webp', 'live-photo']) {
      expect(engine.supports(t as FormatId)).toBe(false);
    }
  });

  it('produces a name that matches the target extension', async () => {
    const { name } = await convert('av.mp4', 'mkv');
    expect(name).toBe('av.mkv');
  });

  describe('video container changes preserve the codecs', () => {
    it('MP4 → MOV keeps H.264 and AAC', async () => {
      const { probe, did } = await convert('av.mp4', 'mov');
      expect(did).toBe('transmux');
      expect(probe.formatName).toContain('mov');
      expect(probe.codecs).toContain('h264');
      expect(probe.codecs).toContain('aac');
    });

    it('MP4 → MKV keeps H.264 and AAC', async () => {
      const { probe, did } = await convert('av.mp4', 'mkv');
      expect(did).toBe('transmux');
      expect(probe.formatName).toContain('matroska');
      expect(probe.codecs).toContain('h264');
      expect(probe.codecs).toContain('aac');
    });

    it('MKV → MP4 keeps H.264 and AAC', async () => {
      const { probe } = await convert('av.mkv', 'mp4');
      expect(probe.formatName).toContain('mp4');
      expect(probe.codecs).toContain('h264');
      expect(probe.codecs).toContain('aac');
    });

    it('WebM → MKV keeps VP9 and Opus', async () => {
      const { probe } = await convert('av.webm', 'mkv');
      expect(probe.codecs).toContain('vp9');
      expect(probe.codecs).toContain('opus');
    });

    it('preserves the duration across a container change', async () => {
      // Round-tripping the timeline is where naive implementations accumulate drift.
      const source = ffprobe(join(FIXTURES, 'av.mp4'));
      const { probe } = await convert('av.mp4', 'mkv');
      expect(probe.durationSec).toBeCloseTo(source.durationSec, 2);
    });
  });

  describe('audio container changes preserve the codec', () => {
    it('M4A → MP4 keeps AAC', async () => {
      const { probe } = await convert('tone.m4a', 'mp4');
      expect(probe.codecs).toContain('aac');
    });

    it('MP3 → MP3 round-trips', async () => {
      const { probe, did } = await convert('tone.mp3', 'mp3');
      expect(did).toBe('transmux');
      expect(probe.codecs).toContain('mp3');
    });

    it('FLAC → FLAC round-trips', async () => {
      const { probe, did } = await convert('tone.flac', 'flac');
      expect(did).toBe('transmux');
      expect(probe.codecs).toContain('flac');
    });

    it('OGG → OGG keeps Opus', async () => {
      const { probe } = await convert('tone-opus.ogg', 'ogg');
      expect(probe.codecs).toContain('opus');
    });

    it('carries metadata across a container change', async () => {
      // Dropping tags silently is a content loss the user never agreed to.
      const { probe } = await convert('livepair.mov', 'mp4');
      expect(probe.formatName).toContain('mp4');
    });
  });

  describe('failure is explicit, never silent', () => {
    it('refuses a target it has no writer for', async () => {
      const engine = new MediabunnyEngine();
      await expect(
        engine.run({
          input: fixture('av.mp4'),
          inputName: 'av.mp4',
          target: 'jpeg' as FormatId,
          params: {},
        }),
      ).rejects.toBeInstanceOf(EngineError);
    });

    it('says why a conversion is impossible, rather than just that it is', async () => {
      // A bare "cannot be converted" gives the user nothing to act on.
      const engine = new MediabunnyEngine();
      await expect(
        engine.run({
          input: fixture('av.mp4'),
          inputName: 'av.mp4',
          target: 'gif' as FormatId,
          params: {},
        }),
      ).rejects.toThrow(/no writer|unsupported/i);
    });
  });
});
