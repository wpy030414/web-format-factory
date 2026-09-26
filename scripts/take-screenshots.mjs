#!/usr/bin/env node
/**
 * Regenerate the README screenshots: docs/screenshot.png and docs/screenshot-capabilities.png.
 *
 * Run with: node scripts/take-screenshots.mjs
 *
 * The converter shot needs files that show the app's whole face — a photo, a video, an
 * audio track, a HEIC — and no real fixture probes to interesting dimensions, so the
 * entries are fabricated straight into the store (exactly what the previous screenshots
 * did: the 84 MB "vacation.mp4" in them never existed as bytes). Sizes are faked by
 * shadowing `File.size` with an own property; nothing in a screenshot ever reads the
 * content. Two of the six entries are *done*, so the toolbar shows two different honest
 * numbers — 开始转换（4） and 全部下载（2） — rather than one count standing in for both.
 *
 * The capabilities shot waits for the real probes: a report still spinning would
 * document a lie about the machine it ran on.
 */
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const MB = 1024 * 1024;

const server = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
});

async function waitForServer(deadlineMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`dev server never came up on ${BASE}`);
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1800, height: 2800 } });

  // --- The converter, mid-session ---------------------------------------------------------
  // A compact scene: three cards (a photo, a video, and one done) show the toolbar's
  // two different counts and the variety of media classes without scrolling. The
  // viewport is sized to the content, not to a fixed canvas — a screenshot that ends
  // with empty space is a screenshot that wasted its pixels.
  await page.goto(`${BASE}/`);
  await page.waitForSelector('[data-testid="batch-switch"]');

  await page.evaluate(async (MB_) => {
    const { useStore, defaultParamsFor } = await import('/src/state/store.ts');

    /** A File whose reported size is whatever the scene calls for, content be damned. */
    const fakeFile = (name, mb) => {
      const file = new File([new Uint8Array([1])], name);
      Object.defineProperty(file, 'size', { value: Math.round(mb * MB_) });
      return file;
    };
    const still = (name, mb, container) => ({
      name,
      size: Math.round(mb * MB_),
      container,
      mediaClass: 'still-image',
      videoTracks: [],
      audioTracks: [],
      otherTrackCount: 0,
    });

    const ready = (id, file, profile, target) => ({
      id,
      file,
      profile,
      status: 'ready',
      target,
      params: defaultParamsFor(target),
    });
    const done = (id, file, profile, target, resultName, resultMb) => ({
      id,
      file,
      profile,
      status: 'done',
      target,
      params: defaultParamsFor(target),
      result: { blob: new Blob([new Uint8Array([1])]), name: resultName, size: Math.round(resultMb * MB_) },
    });

    useStore.setState({
      files: [
        ready('f1', fakeFile('IMG_4032.JPG', 2.1), still('IMG_4032.JPG', 2.1, 'jpeg'), 'webp'),
        {
          ...ready('f2', fakeFile('vacation.mp4', 84), {
            name: 'vacation.mp4',
            size: 84 * MB_,
            container: 'isobmff-mp4',
            mediaClass: 'video',
            videoTracks: [
              { codec: 'avc', width: 1920, height: 1080, decodable: true, frameRate: { average: 29.97, max: 30, constant: true } },
            ],
            audioTracks: [{ codec: 'aac', channels: 2, sampleRate: 48000, decodable: true }],
            otherTrackCount: 0,
          }, 'mkv'),
        },
        done('f3', fakeFile('beach.HEIC', 2.4), still('beach.HEIC', 2.4, 'isobmff-heic'), 'jpeg', 'beach.jpg', 1.4),
      ],
    });
  }, MB);

  // The toolbar text is the scene's point — wait until it is exactly what the shot
  // should say, which also implies capability measurement has settled the pickers.
  await page.waitForFunction(
    () => document.body.innerText.includes('开始转换（2）') && document.body.innerText.includes('全部下载（1）'),
    { timeout: 30_000 },
  );
  await page.waitForTimeout(400);

  const convHeight = await page.evaluate(() => {
    const last = document.querySelector('footer') ?? document.body.lastElementChild;
    return last ? Math.ceil(last.getBoundingClientRect().bottom) : 800;
  });
  await page.setViewportSize({ width: 1200, height: Math.max(800, convHeight + 40) });
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'docs/screenshot.png' });

  // --- The diagnostics page, after the real probes answered --------------------------------
  // The report is short — a few sections, a handful of rows — so the converter's 2800 px
  // canvas leaves most of the frame empty. A separate page with its own viewport sized
  // to the content's natural height: the shot should frame the report, not the void
  // around it.
  const diagPage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await diagPage.goto(`${BASE}/#/capabilities`);
  await diagPage.locator('.animate-spin').waitFor({ state: 'detached', timeout: 120_000 });
  await diagPage.waitForTimeout(400);

  const contentHeight = await diagPage.evaluate(() => {
    const last = document.querySelector('footer') ?? document.body.lastElementChild;
    return last ? Math.ceil(last.getBoundingClientRect().bottom) : 800;
  });
  await diagPage.setViewportSize({ width: 1200, height: Math.max(800, contentHeight + 40) });
  await diagPage.waitForTimeout(200);
  await diagPage.screenshot({ path: 'docs/screenshot-capabilities.png' });
  await diagPage.close();

  await browser.close();
  console.log('docs/screenshot.png and docs/screenshot-capabilities.png regenerated.');
} finally {
  server.kill('SIGTERM');
}
