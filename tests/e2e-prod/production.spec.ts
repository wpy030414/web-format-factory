import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Acceptance against the built artifact, served with the response semantics
 * `deploy/nginx.conf.sample` promises.
 *
 * Three things are checked here that the dev-mode suite structurally cannot check:
 *
 *   1. the *shape* of what was built — that the optional decoders really are separate
 *      chunks and really are absent from the precache manifest;
 *   2. that the app works as an ES module worker, which is what makes those chunks
 *      fetchable at all;
 *   3. that the fallback engine loads over `application/wasm`, the MIME type whose
 *      absence breaks `WebAssembly.instantiateStreaming` with no useful message.
 *
 * What this does **not** establish is that nginx emits those responses. See
 * `scripts/serve-deploy.mjs` — no nginx exists on the machine this was written on, and
 * claiming otherwise would be the exact unverified-assumption failure this project keeps
 * finding in itself.
 */

const DIST = join(process.cwd(), 'dist');
const LAZY_DIR = join(DIST, 'assets/lazy');
const FIXTURES = join(process.cwd(), 'tests/fixtures/generated');
const haveFixtures = existsSync(FIXTURES);
const tmpDirs: string[] = [];

test.afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function ffprobe(file: string): { formatName: string; codecs: string[] } {
  const json = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=format_name', '-show_entries', 'stream=codec_name', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(json) as {
    format?: { format_name?: string };
    streams?: Array<{ codec_name?: string }>;
  };
  return {
    formatName: parsed.format?.format_name ?? '',
    codecs: (parsed.streams ?? []).map((s) => s.codec_name ?? '').filter(Boolean),
  };
}

async function dropFile(page: Page, fixture: string): Promise<void> {
  await page.setInputFiles('input[type=file]', {
    name: fixture,
    mimeType: 'application/octet-stream',
    buffer: readFileSync(join(FIXTURES, fixture)),
  });
}

async function convertAndSave(page: Page, targetLabel: string, saveAs: string): Promise<string> {
  await page.getByRole('button', { name: targetLabel, exact: true }).click();
  await page.getByRole('button', { name: /开始转换/ }).click();

  const downloadButton = page.getByTestId('download-result').first();
  await expect(downloadButton).toBeVisible({ timeout: 150_000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await downloadButton.click();
  const download = await downloadPromise;

  const dir = mkdtempSync(join(tmpdir(), 'wff-prod-'));
  tmpDirs.push(dir);
  const saved = join(dir, saveAs);
  await download.saveAs(saved);
  return saved;
}

test.describe('构建产物', () => {
  test('可选解码器是独立 chunk，没有被并进 worker', () => {
    // The bug this exists for: an `iife` worker cannot contain dynamic imports, so
    // Rolldown inlined the ~3 MB HEIC decoder and the audio encoder extensions straight
    // into the worker chunk. The laziness was real in the source and gone in the
    // artifact — and no dev-mode test can see the difference, because in dev the code is
    // never bundled at all.
    const assets = readdirSync(join(DIST, 'assets'));
    const worker = assets.find((f) => f.startsWith('media.worker-'));
    expect(worker, '没有找到 worker 产物').toBeTruthy();
    expect(statSync(join(DIST, 'assets', worker!)).size).toBeLessThan(1_500_000);

    const lazy = readdirSync(LAZY_DIR);
    expect(lazy.some((f) => f.startsWith('heic-to-'))).toBe(true);
    expect(lazy.some((f) => f.startsWith('mediabunny-mp3-encoder-'))).toBe(true);
  });

  test('Service Worker 不预缓存这些可选解码器', () => {
    // Installing the app must not mean downloading a HEIC decoder nobody asked for.
    const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
    expect(sw).not.toContain('heic-to');
    expect(sw).not.toContain('mp3-encoder');
  });
});

test.describe('部署形态下运行', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  test('跨源隔离在生产响应下确实成立', async ({ page }) => {
    await page.goto('/');
    // The property the deployment config's two headers exist to produce, and the one the
    // fallback engine hangs silently without.
    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  });

  test('HEIC → JPEG：ES 模块 worker 下，懒加载的解码器能取得并真正解码', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    const lazyFetches: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/assets/lazy/')) lazyFetches.push(r.url());
    });

    await page.goto('/');
    await dropFile(page, 'still.heic');
    await expect(page.getByTestId('media-class').first()).toBeVisible({ timeout: 30_000 });

    const saved = await convertAndSave(page, 'JPEG', 'out.jpg');
    expect(ffprobe(saved).codecs).toContain('mjpeg');

    expect(lazyFetches.some((url) => url.includes('heic-to'))).toBe(true);
    expect(consoleErrors).toEqual([]);
  });

  test('WAV → MP3：音频编码扩展同样按需取得', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'tone.wav');
    await expect(page.getByTestId('media-class').first()).toBeVisible({ timeout: 30_000 });

    const saved = await convertAndSave(page, 'MP3', 'out.mp3');

    const probed = ffprobe(saved);
    expect(probed.codecs).toContain('mp3');
    expect(probed.formatName).toContain('mp3');
  });

  test('兜底引擎：wasm 以 application/wasm 送出，跨源隔离下能真正装载', async ({ page }) => {
    // The MIME type is the point. A wasm file served as application/octet-stream makes
    // `WebAssembly.instantiateStreaming` reject, and the fallback engine disappears with
    // no message anyone can act on.
    test.setTimeout(300_000);

    const wasmResponses: Array<{ url: string; type: string }> = [];
    page.on('response', (r) => {
      if (r.url().endsWith('.wasm')) wasmResponses.push({ url: r.url(), type: r.headers()['content-type'] ?? '' });
    });

    await page.goto('/');
    await dropFile(page, 'av.mp4');
    await expect(page.getByTestId('media-class').first()).toBeVisible({ timeout: 30_000 });

    const saved = await convertAndSave(page, 'Live Photo', 'out.livp');

    expect(wasmResponses.length).toBeGreaterThan(0);
    for (const r of wasmResponses) expect(r.type, r.url).toContain('application/wasm');

    // And the artifact is right, which is the only thing that proves the core actually ran.
    const dir = tmpDirs[tmpDirs.length - 1]!;
    execFileSync('unzip', ['-o', '-q', saved, '-d', dir]);
    const listing = execFileSync('unzip', ['-l', saved], { encoding: 'utf8' });
    expect(listing).toMatch(/\.mov/);
  });
});
