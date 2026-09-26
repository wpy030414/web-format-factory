import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The deployment configs, checked against the one thing that makes them load-bearing.
 *
 * Be clear about what this can and cannot do. It cannot prove that nginx sends these
 * headers — no amount of reading a file establishes what a server does with it. What it
 * *can* do is stop the config from quietly losing a directive that the comments say is
 * required, which is a genuinely likely edit: `.wasm` in a MIME list looks like noise, and
 * nginx's `add_header` not inheriting into a `location` that declares its own is the kind
 * of rule people delete while tidying.
 *
 * One assertion here was too weak, and a real deployment proved it (2026-09-26, ADR-012).
 * The old check — "the config contains `application/wasm`" — stayed green on a config that
 * served `/engines/ffmpeg/const.js` as `application/octet-stream`, because a `types` block
 * in a `location` *replaces* the inherited map instead of adding to it. The assertions
 * below now check what a request would actually receive, not which strings are present.
 *
 * The behavioural half lives in `tests/e2e-prod/production.spec.ts`, which runs the built
 * app against a reference implementation of the same contract. Note what that reference
 * implementation is not: it is not nginx, so it cannot reproduce the map replacement —
 * which is exactly why the bug above survived a fully green end-to-end run.
 */

const read = (name: string) => readFileSync(join(process.cwd(), 'deploy', name), 'utf8');

/**
 * The comments in these files discuss `location`, `types` and `add_header`, so the parser
 * reads the config with comments removed — otherwise a sentence *about* a directive gets
 * parsed as one.
 */
const stripComments = (config: string) => config.replace(/#[^\n]*/g, '');

/** The body of a `{ … }` block, given the index just past its opening brace. */
function blockBody(source: string, from: number): { body: string; end: number } {
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    i += 1;
  }
  return { body: source.slice(from, i - 1), end: i };
}

/** Every `location <selector> { … }` body in an nginx config. */
function locationBlocks(config: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const opener = /location\s+([^{]+)\{/g;

  for (let m = opener.exec(config); m; m = opener.exec(config)) {
    const { body, end } = blockBody(config, opener.lastIndex);
    blocks.set(m[1]!.trim(), body);
    opener.lastIndex = end;
  }
  return blocks;
}

/** The body of the first `types { … }` inside a scope, or null when there is none. */
function typesBlock(scope: string): string | null {
  const opener = /\btypes\s*\{/.exec(scope);
  return opener ? blockBody(scope, opener.index + opener[0].length).body : null;
}

/** `js` as an extension — not the `js` inside `application/javascript`. */
const MAPS_JS = /(^|\s)js(\s|;)/;

const ISOLATION = [
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Embedder-Policy',
  'Cross-Origin-Resource-Policy',
];

describe('deploy/nginx.conf.sample', () => {
  const config = stripComments(read('nginx.conf.sample'));
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
    // (Note what this alone does *not* prove — see the two tests below.)
    expect(config).toMatch(/application\/wasm\s+wasm;/);
    expect(config).toContain('application/wasm');
  });

  it('/engines/ 的 types 块必须把 .js 一起列上——真机上咬到的就是这一口', () => {
    // 2026-09-26，这套配置第一次上真机（nginx/1.28.3 Ubuntu）：
    //
    //   $ curl -sI https://…/engines/ffmpeg/const.js | grep -i content-type
    //   content-type: application/octet-stream
    //
    // 浏览器于是拒绝把它当模块脚本执行：
    //   TypeError: 'application/octet-stream' is not a valid JavaScript MIME type
    // 而 const.js 是 ffmpeg.wasm 那个 module worker 的第一层 import（worker.js 里
    // import './const.js'），所以「GIF → Live Photo」在这条路上永远停住：
    // FFmpeg.load() 既不 resolve 也不 reject，界面停在「转换中」。
    //
    // 根因就在这份配置里。nginx 的 `types` 在 location 层是**替换**而不是叠加
    // （`ngx_http_core_module.c`：`if (conf->types == NULL) { conf->types = prev->types; … }`），
    // 原先那个只声明 wasm 的块，顺手把 http 层 mime.types 里的 js 映射一起丢掉了。
    //
    // 断言的是「这张表里有没有 js」，而不是「文件里出现过 application/wasm」——
    // 后者在坏掉的那版配置上同样成立，这正是它当初没拦住的原因。
    const engines = locations.get('/engines/');
    const types = engines ? typesBlock(engines) : null;

    expect(types, 'location /engines/ 里的 types 块不见了').toBeTruthy();
    expect(types, '/engines/ 丢掉了 .js 映射，模块 worker 会加载不了').toMatch(MAPS_JS);
    expect(types, '/engines/ 丢掉了 .wasm 映射').toMatch(/(^|\s)wasm(\s|;)/);
  });

  it('前缀匹配的 location 一旦声明 types，就必须自己补回 .js', () => {
    // 上一条的一般化：把同一条规则铺到整份配置上。`types` 换掉的是**整张继承表**，
    // 所以任何非精确匹配的 location 声明了 types，都得自己把 .js 写回来。
    // 精确匹配（`= /x.ext`）只可能命中那一个文件，因此豁免。
    for (const [selector, body] of locations) {
      const types = typesBlock(body);
      if (!types || selector.startsWith('=')) continue;
      expect(types, `location ${selector} 的 types 块丢掉了 .js 映射`).toMatch(MAPS_JS);
    }
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
