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

/** `width,height` of the first video stream, straight from ffprobe. */
function ffprobeSize(file: string): { width: number; height: number } {
  const out = execFileSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  ).trim();
  const [width, height] = out.split(',').map(Number);
  return { width: width ?? 0, height: height ?? 0 };
}

/** Drop several fixtures at once, optionally renaming them. */
async function dropFiles(
  page: Page,
  items: Array<{ fixture: string; as: string }>,
): Promise<void> {
  await page.setInputFiles(
    'input[type=file]',
    items.map(({ fixture, as }) => ({
      name: as,
      mimeType: 'application/octet-stream',
      buffer: readFileSync(join(FIXTURES, fixture)),
    })),
  );
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

test.describe('HEIC — 只有 Safari 能原生解码的那一类', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  test('HEIC → JPEG：浏览器不会解码时，用内置解码器解出真正的像素', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'still.heic');

    // HEIC is what every recent iPhone writes, and outside Safari nothing can read it.
    // Before this it came back `unknown` and the card offered no targets at all — the
    // most common photograph in the world, and nothing to do with it.
    expect(await waitForClass(page)).toBe('静态图像');

    const saved = await convertAndSave(page, 'JPEG', 'out.jpg');

    expect(ffprobe(saved).codecs).toContain('mjpeg');
    // The dimensions are what proves the pixels were really decoded: a decoder that
    // silently handed back nothing would still produce a file, just an empty one.
    expect(ffprobeSize(saved)).toEqual({ width: 64, height: 64 });
  });

  test('HEIC → PNG：同样走内置解码器，得到无损产物', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'still.heic');
    await waitForClass(page);

    const saved = await convertAndSave(page, 'PNG', 'out.png');

    expect(ffprobe(saved).codecs).toContain('png');
    expect(ffprobeSize(saved)).toEqual({ width: 64, height: 64 });
  });
});

test.describe('音频编码器扩展', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  test('WAV → MP3：浏览器没有 MP3 编码器时，自动取回 WASM 编码器', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'tone.wav');
    expect(await waitForClass(page)).toBe('音频');

    const saved = await convertAndSave(page, 'MP3', 'out.mp3');

    // `mp3` in an `mp3` container: the codec name is the whole point. Handing back a WAV
    // with a .mp3 name would satisfy a weaker test and none of the user's intent.
    const probed = ffprobe(saved);
    expect(probed.codecs).toContain('mp3');
    expect(probed.formatName).toContain('mp3');
  });

  test('WAV → FLAC：同样取回 WASM 编码器，产物是真正的 FLAC', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'tone.wav');
    await waitForClass(page);

    const saved = await convertAndSave(page, 'FLAC', 'out.flac');

    const probed = ffprobe(saved);
    expect(probed.codecs).toContain('flac');
    expect(probed.formatName).toContain('flac');
  });
});

test.describe('动图转换', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  test('动态 WebP → GIF：走浏览器自带的取帧 API，不惊动兜底引擎', async ({ page }) => {
    // The reason this test watches the network rather than only the artifact: both paths
    // produce a correct GIF, so an artifact check alone cannot tell them apart. The whole
    // point of decoding through ImageDecoder is that it does *not* cost a 31 MB download,
    // and that is a claim worth pinning down.
    //
    // Matched on the core's own filename rather than on "ffmpeg": the worker statically
    // imports the fallback engine's *module*, so every conversion that ever ran requests
    // /src/engines/ffmpeg/index.ts in dev, and matching that would flag all of them.
    const fallbackCoreFetches: string[] = [];
    page.on('request', (request) => {
      if (/\/engines\/.*ffmpeg-core/.test(request.url())) fallbackCoreFetches.push(request.url());
    });

    await page.goto('/');
    await dropFile(page, 'anim.webp');
    expect(await waitForClass(page)).toBe('动图');

    const saved = await convertAndSave(page, 'GIF', 'out.gif');

    expect(ffprobe(saved).formatName).toContain('gif');
    expect(fallbackCoreFetches).toEqual([]);
  });

  test('视频 → GIF：产物是一个真正的 GIF', async ({ page }) => {
    await page.goto('/');
    // WebM/VP9 rather than H.264: the test browser decodes it without relying on a
    // licensed codec being present in the build.
    await dropFile(page, 'av.webm');
    expect(await waitForClass(page)).toBe('视频');

    await page.getByRole('button', { name: 'GIF', exact: true }).click();

    const convert = page.getByRole('button', { name: /开始转换/ });
    await expect(convert).toBeEnabled({ timeout: 15_000 });
    await convert.click();

    const downloadButton = page.getByTestId('download-result').first();
    await expect(downloadButton).toBeVisible({ timeout: 120_000 });
    await expect(downloadButton).toHaveText(/\.gif$/);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;

    const dir = mkdtempSync(join(tmpdir(), 'wff-e2e-'));
    tmpDirs.push(dir);
    const saved = join(dir, 'out.gif');
    await download.saveAs(saved);

    // The artifact must be a real GIF, not merely a file with the right name.
    const probe = ffprobe(saved);
    expect(probe.codecs).toContain('gif');
  });

  test('GIF → 视频：产物是一个真正的 WebM', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'anim.gif');
    expect(await waitForClass(page)).toBe('动图');

    await page.getByRole('button', { name: 'WebM', exact: true }).click();

    const convert = page.getByRole('button', { name: /开始转换/ });
    await expect(convert).toBeEnabled({ timeout: 15_000 });
    await convert.click();

    const downloadButton = page.getByTestId('download-result').first();
    await expect(downloadButton).toBeVisible({ timeout: 120_000 });

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;

    const dir = mkdtempSync(join(tmpdir(), 'wff-e2e-'));
    tmpDirs.push(dir);
    const saved = join(dir, 'out.webm');
    await download.saveAs(saved);

    const probe = ffprobe(saved);
    expect(probe.formatName).toContain('webm');
    expect(probe.codecs).toContain('vp9');
  });

  test('GIF → 静图：取第一帧，并把这次投影如实标出来', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'anim.gif');
    await waitForClass(page);

    await page.getByRole('button', { name: 'JPEG', exact: true }).click();

    // Taking one frame out of a moving sequence is a projection, and the plan must say
    // so rather than presenting it as an ordinary format change.
    const plan = page.getByTestId('plan-summary');
    await expect(plan.getByText('投影')).toBeVisible();
    await expect(plan.getByText(/将从动态内容中选取一帧/)).toBeVisible();

    const saved = await convertAndSave(page, 'JPEG', 'out.jpg');
    expect(ffprobe(saved).codecs).toContain('mjpeg');
  });
});

test.describe('Live Photo', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  test('把 Motion Photo 识别为 Live Photo，而不是普通 JPEG', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'motionphoto.jpg');
    // The whole point: it *is* a JPEG, and calling it one would hide the video half.
    expect(await waitForClass(page)).toBe('Live Photo');
  });

  test('Motion Photo → MP4：取出视频那一半', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'motionphoto.jpg');
    await waitForClass(page);

    // Splitting a bundle drops the other half, so the plan must say projection rather
    // than presenting it as an ordinary conversion.
    await page.getByRole('button', { name: 'MP4', exact: true }).click();
    await expect(page.getByTestId('plan-summary').getByText('投影')).toBeVisible();

    const saved = await convertAndSave(page, 'MP4', 'out.mp4');
    const probe = ffprobe(saved);
    expect(probe.formatName).toContain('mp4');
    expect(probe.codecs).toContain('h264');
  });

  test('Motion Photo → JPEG：导出静图，并剥掉已经失效的 Motion Photo 声明', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'motionphoto.jpg');
    await waitForClass(page);

    const saved = await convertAndSave(page, 'JPEG', 'out.jpg');
    expect(ffprobe(saved).codecs).toContain('mjpeg');

    // The exported still must not keep claiming to contain a video it no longer has.
    // A file that lies about its own contents is exactly what this project refuses.
    const bytes = readFileSync(saved);
    expect(bytes.includes(Buffer.from('Camera:MotionPhoto'))).toBe(false);
    expect(bytes.includes(Buffer.from('Camera:MicroVideoOffset'))).toBe(false);
  });

  test('.livp → 视频：从压缩包里取出 MOV', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'pair.livp');
    expect(await waitForClass(page)).toBe('Live Photo');

    const saved = await convertAndSave(page, 'MP4', 'out.mp4');
    expect(ffprobe(saved).codecs).toContain('h264');
  });

  test('多文件拖入时，按配对标识合成一个 Live Photo 条目', async ({ page }) => {
    await page.goto('/');
    await dropFiles(page, [
      { fixture: 'pair-tagged.jpg', as: 'pair-tagged.jpg' },
      { fixture: 'pair-tagged.mov', as: 'pair-tagged.mov' },
    ]);

    // Two files in, one entry out. Showing them separately would invite the user to
    // convert each half on its own — exactly what they did not mean.
    await expect(page.getByTestId('media-class')).toHaveCount(1, { timeout: 30_000 });
    expect(await waitForClass(page)).toBe('Live Photo');

    const note = page.getByTestId('pairing-note');
    await expect(note).toBeVisible();
    // How the match was made has to be stated: an identifier is evidence, a filename is
    // a guess, and they are not equally trustworthy.
    await expect(note).toContainText('相同的配对标识');

    // And the assembled entry has to actually work. Pairing that produces a card the
    // pipeline cannot convert would be worse than not pairing at all.
    const saved = await convertAndSave(page, 'MP4', 'out.mp4');
    expect(ffprobe(saved).codecs).toContain('h264');
  });

  test('标识缺失时退回按文件名配对，并如实说明这是猜测', async ({ page }) => {
    await page.goto('/');
    await dropFiles(page, [
      { fixture: 'still.jpg', as: 'holiday.jpg' },
      { fixture: 'av.mov', as: 'holiday.mov' },
    ]);

    await expect(page.getByTestId('media-class')).toHaveCount(1, { timeout: 30_000 });
    expect(await waitForClass(page)).toBe('Live Photo');
    await expect(page.getByTestId('pairing-note')).toContainText('按文件名配对');
  });
});

test.describe('编码参数', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  test('切换目标会带上该格式的参数，并按声明的默认值播种', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'av.mp4');
    await waitForClass(page);

    await page.getByRole('button', { name: 'Matroska', exact: true }).click();
    // Matroska declares a codec choice, so the panel must offer it.
    await expect(page.getByTestId('param-panel')).toBeVisible();
    await expect(page.getByTestId('param-codec')).toBeVisible();
  });

  test('改参数会改变代价判定，而不是事后再补一句说明', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'av.mp4');
    await waitForClass(page);

    await page.getByRole('button', { name: 'Matroska', exact: true }).click();
    const plan = page.getByTestId('plan-summary');

    // With no parameters set, the codecs fit and this is a free container change.
    await expect(plan.getByText('无损', { exact: true })).toBeVisible();
    await expect(plan.getByText('瞬时（换容器）')).toBeVisible();

    // Choosing a different codec forces a re-encode. The verdict has to follow the
    // setting that caused it — a summary that still promised "lossless" here would be
    // telling the user something the conversion is not going to do.
    await page.getByTestId('param-codec').selectOption('vp9');
    await expect(plan.getByText('需重新编码')).toBeVisible();
  });

  test('改参数会真的传到转换里', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'av.mp4');
    await waitForClass(page);

    await page.getByRole('button', { name: 'Matroska', exact: true }).click();
    await page.getByTestId('param-codec').selectOption('vp9');

    const saved = await convertAndSave(page, 'Matroska', 'out.mkv');
    // VP9, not the source's H.264 — proof the setting reached the encoder.
    expect(ffprobe(saved).codecs).toContain('vp9');
  });
});

test.describe('兜底引擎', () => {
  test.skip(!haveFixtures, '测试样本缺失，先运行 pnpm fixtures');

  // This is the only route in the project that needs the 32 MB fallback core, so the
  // first job here pays for downloading and instantiating it. On a dev server the wasm
  // arrives from localhost in well under a second — do not read that as representative
  // of a real network. The generous timeout is for slow machines and CI.
  test.setTimeout(300_000);

  test('动态 WebP 编码：这条路由只有兜底引擎能做', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'av.webm');
    await waitForClass(page);

    await page.getByRole('button', { name: 'Animated WebP', exact: true }).click();
    await page.getByRole('button', { name: /开始转换/ }).click();

    const downloadButton = page.getByTestId('download-result').first();
    await expect(downloadButton).toBeVisible({ timeout: 240_000 });
    await expect(downloadButton).toHaveText(/\.webp$/);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;

    const dir = mkdtempSync(join(tmpdir(), 'wff-e2e-'));
    tmpDirs.push(dir);
    const saved = join(dir, 'out.webp');
    await download.saveAs(saved);

    // `webp_anim`, not `webp`: a still image would mean the animation was dropped.
    expect(ffprobe(saved).codecs).toContain('webp_anim');
  });

  test('动态 PNG：这条路由此前承诺了却没人做，现在由兜底引擎兑现', async ({ page }) => {
    // Animated PNG was offered by the router from the beginning and no engine could
    // produce it, so picking it failed at the very end of the job. This asserts the
    // artifact rather than the absence of an error, because the absence of an error was
    // never the problem.
    await page.goto('/');
    await dropFile(page, 'av.webm');
    await waitForClass(page);

    await page.getByRole('button', { name: 'Animated PNG', exact: true }).click();
    await page.getByRole('button', { name: /开始转换/ }).click();

    const downloadButton = page.getByTestId('download-result').first();
    await expect(downloadButton).toBeVisible({ timeout: 240_000 });
    await expect(downloadButton).toHaveText(/\.png$/);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;

    const dir = mkdtempSync(join(tmpdir(), 'wff-e2e-'));
    tmpDirs.push(dir);
    const saved = join(dir, 'out.png');
    await download.saveAs(saved);

    // `apng`, not `png`: the still-image muxer would write the first frame and call it
    // an animation, and ffprobe names the difference.
    expect(ffprobe(saved).codecs).toContain('apng');
  });

  test('Ogg + Vorbis：参数面板一直写着需要兜底引擎，这条测试要求它兑现', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'tone.wav');
    await waitForClass(page);

    await page.getByRole('button', { name: 'Ogg', exact: true }).click();
    // Vorbis is the whole point of this test — the default, Opus, has a native encoder
    // and would never reach the fallback engine at all.
    await page.getByTestId('param-codec').selectOption('vorbis');
    await page.getByRole('button', { name: /开始转换/ }).click();

    const downloadButton = page.getByTestId('download-result').first();
    await expect(downloadButton).toBeVisible({ timeout: 240_000 });
    await expect(downloadButton).toHaveText(/\.ogg$/);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;

    const dir = mkdtempSync(join(tmpdir(), 'wff-e2e-'));
    tmpDirs.push(dir);
    const saved = join(dir, 'out.ogg');
    await download.saveAs(saved);

    const probed = ffprobe(saved);
    expect(probed.formatName).toContain('ogg');
    expect(probed.codecs).toContain('vorbis');
  });

  test('组装 Live Photo：把视频做成一个带配对标识的 .livp', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'av.mp4');
    await waitForClass(page);

    await page.getByRole('button', { name: 'Live Photo', exact: true }).click();
    await page.getByRole('button', { name: /开始转换/ }).click();

    const downloadButton = page.getByTestId('download-result').first();
    await expect(downloadButton).toBeVisible({ timeout: 240_000 });
    await expect(downloadButton).toHaveText(/\.livp$/);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await downloadButton.click();
    const download = await downloadPromise;

    const dir = mkdtempSync(join(tmpdir(), 'wff-e2e-'));
    tmpDirs.push(dir);
    const saved = join(dir, 'out.livp');
    await download.saveAs(saved);

    // Verify with tools that share no code with ours: unzip the archive, then ask
    // ffprobe whether the video half really carries Apple's pairing identifier.
    const listing = execFileSync('unzip', ['-l', saved], { encoding: 'utf8' });
    expect(listing).toMatch(/\.jpg/);
    expect(listing).toMatch(/\.mov/);

    execFileSync('unzip', ['-o', '-q', saved, '-d', dir]);
    const movName = execFileSync('bash', ['-c', `cd ${dir} && ls *.mov`], { encoding: 'utf8' }).trim();
    const tags = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', join(dir, movName)],
      { encoding: 'utf8' },
    );
    // Without this tag the two halves are not a pair, and no Apple device would treat
    // the result as a Live Photo.
    expect(tags).toContain('com.apple.quicktime.content.identifier');
  });
});

test.describe('能力诊断页', () => {
  test('从页脚进入，并报告真实的探测结果', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /本机能力诊断/ }).click();

    await expect(page.getByRole('heading', { name: '本机能力诊断' })).toBeVisible();
    // The probe is async; wait for the report rather than the spinner.
    await expect(page.getByText('跨源隔离（COOP/COEP）')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('已开启')).toBeVisible();
  });

  test('列出各编码的实测可用性', async ({ page }) => {
    await page.goto('/#/capabilities');
    await expect(page.getByText('视频编码')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('音频编码')).toBeVisible();
    // Codec names come from the probe tables, not from a static list. Each appears in
    // both the encode and the decode table, hence `.first()`.
    await expect(page.getByText('H.264', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Opus', { exact: true }).first()).toBeVisible();
  });

  test('把探测结果翻译成「这对应用意味着什么」', async ({ page }) => {
    await page.goto('/#/capabilities');
    // A page of green ticks is not actionable on its own; the consequences are.
    await expect(page.getByText('这些结果意味着什么')).toBeVisible({ timeout: 20_000 });
  });

  test('可以回到转换器', async ({ page }) => {
    await page.goto('/#/capabilities');
    await page.getByRole('link', { name: /返回转换器/ }).click();
    await expect(page.getByRole('heading', { name: 'Web Format Factory' })).toBeVisible();
  });
});
