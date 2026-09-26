import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * End-to-end acceptance.
 *
 * The standard is not "the button worked" but "the file that came out the other end is
 * correct" — so the downloaded artifact is handed to ffprobe and checked, exactly as
 * the engine-level integration tests do.
 *
 * Only transmux paths are asserted here. A container change copies the encoded packets
 * and needs no codec, so it is deterministic in CI; anything crossing codecs depends on
 * the host's hardware encoders and belongs in a manual compatibility matrix.
 */

const FIXTURES = join(process.cwd(), 'tests/fixtures/generated');
const haveFixtures = existsSync(FIXTURES);
const tmpDirs: string[] = [];

test.afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function ffprobe(file: string): { formatName: string; codecs: string[] } {
  const json = execFileSync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=format_name',
      '-show_entries', 'stream=codec_name',
      '-of', 'json',
      file,
    ],
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

async function dropFile(page: Page, fixture: string, asName?: string): Promise<void> {
  await page.setInputFiles('input[type=file]', {
    name: asName ?? fixture,
    mimeType: 'application/octet-stream',
    buffer: readFileSync(join(FIXTURES, fixture)),
  });
}

/** The detected-class badge on the first file card. */
const classBadge = (page: Page): Locator => page.getByTestId('media-class').first();

/** Wait for probing to finish and return the detected class label. */
async function waitForClass(page: Page): Promise<string> {
  await expect(classBadge(page)).toBeVisible({ timeout: 30_000 });
  return (await classBadge(page).textContent())?.trim() ?? '';
}

/**
 * Run a conversion and save the resulting file to disk.
 *
 * The app presents the finished file with a download button rather than auto-saving,
 * so that a batch of twenty conversions does not fire twenty browser download prompts.
 * The download therefore starts when the user asks for it, not when the job ends.
 */
async function convertAndSave(page: Page, targetLabel: string, saveAs: string): Promise<string> {
  await page.getByRole('button', { name: targetLabel, exact: true }).click();
  await page.getByRole('button', { name: /开始转换/ }).click();

  // Wait for the job to actually finish before asking for the file.
  const downloadButton = page.getByTestId('download-result').first();
  await expect(downloadButton).toBeVisible({ timeout: 60_000 });

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await downloadButton.click();
  const download = await downloadPromise;

  const dir = mkdtempSync(join(tmpdir(), 'wff-e2e-'));
  tmpDirs.push(dir);
  const saved = join(dir, saveAs);
  await download.saveAs(saved);
  return saved;
}

test.describe('页面与语义边界', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('渲染标题与隐私声明', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Web Format Factory' })).toBeVisible();
    await expect(page.getByText('没有上传，没有服务器，没有账户')).toBeVisible();
  });

  test('在未选择任何文件时，主动说明本工具拒绝做什么', async ({ page }) => {
    // Stating the refusals up front sets expectations before the user forms any.
    await expect(page.getByText('这个工具不会替你做的事')).toBeVisible();
    await expect(page.getByText(/不会把音频变成视频/)).toBeVisible();
    await expect(page.getByText(/不会把一张静图拉成动图/)).toBeVisible();
    await expect(page.getByText(/不会缩放分辨率/)).toBeVisible();
  });

  test('开发服务器下发了跨源隔离响应头', async ({ page }) => {
    // Only the fallback ffmpeg engine needs this, but it must be verifiable rather
    // than assumed — a missing header makes that engine hang silently.
    expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
  });

  test('上传控件可以通过键盘触达', async ({ page }) => {
    // A bare drop target is not accessible.
    await expect(page.getByRole('button', { name: /把文件拖到这里/ })).toBeVisible();
  });
});

test.describe('识别与目标选择', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  test('把 MP4 识别为视频并给出视频目标', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'av.mp4');

    expect(await waitForClass(page)).toBe('视频');
    await expect(page.getByText(/AVC 64×64/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Matroska', exact: true })).toBeVisible();
  });

  test('默认选中的目标不是源格式本身', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'av.mp4');
    await waitForClass(page);

    const selected = page.locator('button[aria-pressed="true"]').first();
    await expect(selected).toBeVisible();
    await expect(selected).not.toHaveText('MP4');
  });

  test('扩展名与内容不符时以内容为准', async ({ page }) => {
    await page.goto('/');
    // A PNG named .jpg must still be read as a PNG.
    await dropFile(page, 'still.png', 'mislabeled.jpg');
    expect(await waitForClass(page)).toBe('静态图像');
  });

  test('识别动图而不是当成静图', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'anim.gif');
    expect(await waitForClass(page)).toBe('动图');
  });

  test('音频源列出不可达的目标，并说明理由', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'tone.mp3');
    expect(await waitForClass(page)).toBe('音频');

    // Audio → video is the headline refusal; it must be explained, not just greyed out.
    const toggle = page.getByRole('button', { name: /种格式不可选，查看理由/ });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByText(/并不包含画面|那是创作/).first()).toBeVisible();
  });

  test('静图不会提供动图或 Live Photo 目标', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'still.png');
    await waitForClass(page);

    const toggle = page.getByRole('button', { name: /种格式不可选，查看理由/ });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByText(/无法被拉伸成运动|单帧/).first()).toBeVisible();
    await expect(page.getByText(/没有视频的那一半|还需要一段视频/).first()).toBeVisible();
  });

  test('无法识别的文件给出解释，而不是空白的选择器', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[type=file]', {
      name: 'junk.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('this is not media content at all'),
    });
    expect(await waitForClass(page)).toBe('无法识别');
    await expect(page.getByText(/无法从文件内容识别/)).toBeVisible();
  });
});

test.describe('端到端转换并校验产物', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  test('MP4 → MKV：换容器后产物可被 ffprobe 正确识别', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'av.mp4');
    await waitForClass(page);

    await page.getByRole('button', { name: 'Matroska', exact: true }).click();

    // The plan must promise a lossless container change *before* we start, not after.
    const plan = page.getByTestId('plan-summary');
    await expect(plan.getByText('无损')).toBeVisible();
    await expect(plan.getByText('瞬时（换容器）')).toBeVisible();

    await page.getByRole('button', { name: /开始转换/ }).click();

    const downloadButton = page.getByTestId('download-result').first();
    await expect(downloadButton).toBeVisible({ timeout: 60_000 });
    await expect(downloadButton).toHaveText(/av\.mkv/);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('av.mkv');

    const dir = mkdtempSync(join(tmpdir(), 'wff-e2e-'));
    tmpDirs.push(dir);
    const saved = join(dir, 'out.mkv');
    await download.saveAs(saved);

    // The real acceptance criterion: the artifact is correct, not merely present.
    const probe = ffprobe(saved);
    expect(probe.formatName).toContain('matroska');
    expect(probe.codecs).toContain('h264');
    expect(probe.codecs).toContain('aac');
  });

  test('MKV → MP4：反向换容器同样正确', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'av.mkv');
    await waitForClass(page);

    const saved = await convertAndSave(page, 'MP4', 'out.mp4');
    const probe = ffprobe(saved);
    expect(probe.formatName).toContain('mp4');
    expect(probe.codecs).toContain('h264');
    expect(probe.codecs).toContain('aac');
  });
});

test.describe('图像转换', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  test('PNG → JPEG：产物是一张真正的 JPEG', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'still.png');
    expect(await waitForClass(page)).toBe('静态图像');

    const saved = await convertAndSave(page, 'JPEG', 'out.jpg');
    expect(ffprobe(saved).codecs).toContain('mjpeg');
  });

  test('PNG → WebP：产物是一张 WebP', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'still.png');
    await waitForClass(page);

    const saved = await convertAndSave(page, 'WebP', 'out.webp');
    expect(ffprobe(saved).codecs).toContain('webp');
  });

  test('JPEG → PNG：目标无损，但源已经丢过数据，所以仍报有损', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'still.jpg');
    await waitForClass(page);

    await page.getByRole('button', { name: 'PNG', exact: true }).click();

    // PNG preserves every sample, yet the source is a JPEG that already discarded some.
    // Reporting "lossless" here would be technically true of the encoder and a lie about
    // the file — this is the honesty rule the whole loss model exists to enforce.
    const plan = page.getByTestId('plan-summary');
    await expect(plan.getByText('有损', { exact: true })).toBeVisible();
    await expect(plan.getByText(/丢过数据|不会变好/)).toBeVisible();

    await page.getByRole('button', { name: /开始转换/ }).click();
    const downloadButton = page.getByTestId('download-result').first();
    await expect(downloadButton).toBeVisible({ timeout: 60_000 });

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;

    const dir = mkdtempSync(join(tmpdir(), 'wff-e2e-'));
    tmpDirs.push(dir);
    const saved = join(dir, 'out.png');
    await download.saveAs(saved);
    expect(ffprobe(saved).codecs).toContain('png');
  });

  test('带透明的 PNG 转 JPEG 会警告，并要求确认后才放行', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'alpha.png');
    await waitForClass(page);

    await page.getByRole('button', { name: 'JPEG', exact: true }).click();

    // JPEG has no alpha channel, so this loss is real and irreversible — it must be
    // stated, and it must gate the button rather than happening silently.
    const plan = page.getByTestId('plan-summary');
    await expect(plan.getByText(/透明度将被丢弃/)).toBeVisible();
    await expect(plan.getByText('需确认')).toBeVisible();

    const convert = page.getByRole('button', { name: /开始转换/ });
    await expect(convert).toBeDisabled();

    // Only after acknowledging does it become possible.
    await page.getByRole('checkbox').check();
    await expect(convert).toBeEnabled();
  });

  test('带透明的 PNG 转 WebP 不会警告，因为 WebP 支持透明', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'alpha.png');
    await waitForClass(page);

    await page.getByRole('button', { name: 'WebP', exact: true }).click();
    const plan = page.getByTestId('plan-summary');

    // WebP carries alpha natively, so there is nothing to warn about. Its default
    // encoding is still lossy, so the fidelity badge correctly reads 有损 — the point
    // of this test is only that no transparency is lost.
    await expect(plan).toBeVisible();
    await expect(plan.getByText(/透明度将被丢弃/)).toHaveCount(0);
  });
});
