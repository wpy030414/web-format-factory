#!/usr/bin/env node
/**
 * A reference implementation of what `deploy/nginx.conf.sample` promises.
 *
 * Why this exists: the deployment config is a file nobody can test on a machine without
 * nginx, and its load-bearing properties — the cross-origin isolation headers and the MIME
 * types — fail *silently* when they go missing. `FFmpeg.load()` neither resolves nor
 * rejects without the headers; a module worker served as the wrong type never executes,
 * and the fallback engine is simply never there.
 *
 * So the end-to-end suite runs against this instead, and what that buys is precise:
 * the built artifact is proven to work *under these response semantics*. It does **not**
 * prove that nginx emits them — and that gap stopped being theoretical on 2026-09-26, when
 * the sample went onto a real nginx and served `/engines/ffmpeg/const.js` as
 * `application/octet-stream` while every check in this repository stayed green. The reason
 * is structural: this server's MIME table is one hand-written map covering the whole
 * origin, whereas nginx keeps the map per context and a `types` block in a `location`
 * *replaces* the inherited one. A config bug of that shape cannot appear here at all, so
 * a green run here can never rule it out. See `docs/DECISIONS.md` ADR-012.
 *
 * What closes the remaining gap is `tests/unit/deploy-config.test.ts`, now asserting the
 * *rule* that broke instead of the directive that was missing — read that header for what
 * it still cannot prove.
 *
 * Deliberately dependency-free: a server that needs installing is a server that will not
 * be run.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : 4173) || 4173;
const ROOT = join(process.cwd(), 'dist');

if (!existsSync(ROOT)) {
  console.error(`dist/ 不存在，先运行 pnpm build`);
  process.exit(1);
}

/** Exactly the header set the nginx sample declares, and the reason it repeats it per location. */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Cache policy, mirroring the sample's three rules.
 *
 * The `/engines/` case is the one with a real failure mode: those filenames are stable
 * across releases, so caching them for a year would leave every returning user running
 * last month's wasm.
 */
function cacheControl(pathname) {
  if (pathname === '/sw.js') return 'no-cache, no-store, must-revalidate';
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (pathname.startsWith('/engines/')) return 'public, max-age=604800';
  return 'no-cache';
}

/** Resolve a URL path inside `dist/`, refusing anything that escapes it. */
function resolve(pathname) {
  const decoded = decodeURIComponent(pathname.split('?')[0]);
  const target = normalize(join(ROOT, decoded));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...ISOLATION_HEADERS, ...headers });
  if (body === undefined) res.end();
  else res.end(body);
}

createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  let file = resolve(pathname);

  // A directory or a miss falls back to the shell. The app uses hash routing, so this
  // exists for the diagnostic page's sake rather than for deep links.
  if (!file || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(ROOT, 'index.html');
  }

  const ext = extname(file);
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': cacheControl(pathname),
  };

  res.writeHead(200, {
    ...ISOLATION_HEADERS,
    ...headers,
    'Content-Length': String(statSync(file).size),
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`dist/ 已就绪：http://localhost:${PORT}（跨源隔离响应头已下发）`);
});
