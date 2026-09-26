/**
 * Stage the ffmpeg.wasm core into `public/engines/ffmpeg/`.
 *
 * The core is 32 MB, so it is not committed — it is copied out of the npm packages that
 * already declare it as a dependency, which keeps the repository small and the version
 * pinned by package.json rather than by a binary someone once dropped in.
 *
 * Run automatically before `dev` and `build`.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'engines', 'ffmpeg');

/**
 * The class worker and **its sibling modules**.
 *
 * `worker.js` is an ES module that imports `./const.js` and `./errors.js` relative to its
 * own location, so copying it alone leaves those imports 404ing. Worse, the dev server
 * answers unknown paths with the SPA fallback — an HTML page under a 200 — so the failure
 * is not a clean error but a module that never executes and a `load()` that never
 * resolves. Copying the whole directory costs a few kilobytes and removes the trap.
 */
const CLASS_WORKER_DIR = '@ffmpeg/ffmpeg/dist/esm';

/** The multithreaded core and its pthread pool. */
const CORE_FILES = [
  '@ffmpeg/core-mt/dist/esm/ffmpeg-core.js',
  '@ffmpeg/core-mt/dist/esm/ffmpeg-core.wasm',
  '@ffmpeg/core-mt/dist/esm/ffmpeg-core.worker.js',
];

mkdirSync(out, { recursive: true });

let copied = 0;

/** Copy a file, skipping it when the destination already matches. */
function stage(source, destinationName) {
  const destination = join(out, destinationName);
  if (existsSync(destination) && statSync(destination).size === statSync(source).size) return;
  copyFileSync(source, destination);
  copied += 1;
  console.log(
    `  ${destinationName.padEnd(24)} ${(statSync(destination).size / 1024 / 1024).toFixed(2)} MB`,
  );
}

const workerDir = join(root, 'node_modules', CLASS_WORKER_DIR);
if (!existsSync(workerDir)) {
  console.error(`missing ${CLASS_WORKER_DIR} — run pnpm install first`);
  process.exit(1);
}

// Only the runtime modules; the .d.ts files and source maps are dead weight here.
for (const name of readdirSync(workerDir)) {
  if (!name.endsWith('.js')) continue;
  stage(join(workerDir, name), name);
}

for (const relative of CORE_FILES) {
  const source = join(root, 'node_modules', relative);
  if (!existsSync(source)) {
    console.error(`missing ${relative} — run pnpm install first`);
    process.exit(1);
  }
  stage(source, relative.split('/').pop());
}

if (copied === 0) {
  console.log('ffmpeg core already staged');
} else {
  console.log(`staged ${copied} file(s) into public/engines/ffmpeg`);
}
