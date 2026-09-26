import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The deployment configs, checked against the one thing that makes them load-bearing.
 *
 * Be clear about what this can and cannot do. It cannot prove that nginx sends these
 * headers — there is no nginx on the machine this was written on, and no amount of
 * reading a file will establish what a server does with it. What it *can* do is stop the
 * config from quietly losing a directive that the comments say is required, which is a
 * genuinely likely edit: `.wasm` in a MIME list looks like noise, and nginx's
 * `add_header` not inheriting into a `location` that declares its own is the kind of rule
 * people delete while tidying.
 *
 * The behavioural half lives in `tests/e2e-prod/production.spec.ts`, which runs the built
 * app against a reference implementation of the same contract.
 */

const read = (name: string) => readFileSync(join(process.cwd(), 'deploy', name), 'utf8');

/** Every `location <selector> { ... }` body in an nginx config, by brace matching. */
function locationBlocks(config: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const opener = /location\s+([^{]+)\{/g;

  for (let m = opener.exec(config); m; m = opener.exec(config)) {
    let depth = 1;
    let i = opener.lastIndex;
    while (i < config.length && depth > 0) {
      if (config[i] === '{') depth += 1;
      else if (config[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.set(m[1]!.trim(), config.slice(opener.lastIndex, i - 1));
  }
  return blocks;
}

const ISOLATION = [
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Resource-Policy',
];

describe('deploy/nginx.conf.sample', () => {
  const config = read('nginx.conf.sample');
  const locations = locationBlocks(config);

  it('在每个 location 里重新声明隔离响应头，因为 add_header 不会继承', () => {
    // The footgun in one sentence: `add_header` is inherited only while a level declares
    // none of its own. Add one Cache-Control inside `location /assets/` and the three
    // isolation headers vanish from that response — silently, and only for some assets.
    for (const path of ['/', '/assets/', '/engines/']) {
      const body = locations.get(path);
      expect(body, `缺少 location ${path}`).toBeTruthy();
      for (const header of ISOLATION) {
        expect(body, `location ${path} 少了 ${header}`).toContain(header);
      }
    }
  });

  it('为 .wasm 声明 application/wasm', () => {
    // Served as anything else, `WebAssembly.instantiateStreaming` rejects and the fallback
    // engine is simply absent — with no error the user could act on.
    expect(config).toMatch(/application\/wasm\s+wasm;/);
    expect(config).toContain('application/wasm');
  });

  it('把 Service Worker 排除在缓存之外', () => {
    // A cached sw.js cannot be replaced, so the app can never be updated.
    const sw = locations.get('= /sw.js');
    expect(sw).toBeTruthy();
    expect(sw).toContain('no-store');
  });

  it('把兜底引擎的响应头也带上 always', () => {
    // Without `always`, 4xx and 5xx responses arrive without them — and an error page
    // that is not isolated is how a debugging session turns into a mystery.
    expect(config).toContain('always');
  });

  it('明文访问跳转到 HTTPS', () => {
    // Cross-origin isolation only exists in a secure context, so this is not cosmetic.
    expect(config).toMatch(/return\s+301\s+https:/);
  });
});

describe('deploy/Caddyfile.sample', () => {
  const config = read('Caddyfile.sample');

  it('声明同样的三个隔离响应头', () => {
    for (const header of ISOLATION) expect(config).toContain(header);
  });

  it('把 /engines/ 与 /sw.js 分开处理', () => {
    // Same two reasons as nginx: the engine filenames are stable, and a cached service
    // worker cannot be replaced.
    expect(config).toMatch(/@engines[\s\S]*?max-age=604800/);
    expect(config).toMatch(/@sw[\s\S]*?no-store/);
  });
});
