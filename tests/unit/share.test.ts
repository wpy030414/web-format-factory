import { afterEach, describe, expect, it, vi } from 'vitest';

import { canShareFiles, shareFiles } from '@/lib/share.ts';

/**
 * Handing files to the system share sheet.
 *
 * Worth testing despite being three functions because every one of them is a platform
 * probe: `navigator.share` exists on browsers that refuse the `files` parameter, and
 * calling it there throws. The app must hide the button rather than offer one that fails —
 * so the detection, not the sharing, is what these cases are really about.
 */

const file = { blob: new Blob(['x'], { type: 'image/jpeg' }), name: 'a.jpg' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canShareFiles', () => {
  it('没有 canShare 就说不行，而不是假定可以', () => {
    vi.stubGlobal('navigator', {});
    expect(canShareFiles([file])).toBe(false);
  });

  it('canShare 抛错时也说不行（平台会为此抛异常）', () => {
    vi.stubGlobal('navigator', {
      canShare: () => {
        throw new TypeError('files unsupported');
      },
    });
    expect(canShareFiles([file])).toBe(false);
  });

  it('平台说可以就是可以', () => {
    const seen: ShareData[] = [];
    vi.stubGlobal('navigator', {
      canShare: (data: ShareData) => {
        seen.push(data);
        return true;
      },
    });
    expect(canShareFiles([file])).toBe(true);
    // The probe has to look at the actual files: a browser can accept some types and not
    // others, so testing with an empty payload would answer the wrong question.
    expect(seen[0]?.files?.[0]?.name).toBe('a.jpg');
  });
});

describe('shareFiles', () => {
  it('把 blob 包成带名字的文件交给分享面板', async () => {
    const shared: ShareData[] = [];
    vi.stubGlobal('navigator', {
      share: async (data: ShareData) => {
        shared.push(data);
      },
    });

    expect(await shareFiles([file])).toBe('shared');
    expect(shared[0]?.files?.[0]?.name).toBe('a.jpg');
    expect(shared[0]?.files?.[0]?.type).toBe('image/jpeg');
  });

  it('用户取消不是错误', async () => {
    vi.stubGlobal('navigator', {
      share: async () => {
        const abort = new Error('cancelled');
        abort.name = 'AbortError';
        throw abort;
      },
    });
    expect(await shareFiles([file])).toBe('cancelled');
  });

  it('真正的失败如实返回', async () => {
    vi.stubGlobal('navigator', {
      share: async () => {
        throw new Error('boom');
      },
    });
    expect(await shareFiles([file])).toBe('failed');
  });

  it('没有 share 就是 unsupported', async () => {
    vi.stubGlobal('navigator', {});
    expect(await shareFiles([file])).toBe('unsupported');
  });
});
