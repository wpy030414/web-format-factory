import { afterEach, describe, expect, it, vi } from 'vitest';

import { canSaveToFolder, zipNameFor } from '@/lib/save.ts';

/**
 * Saving more than one file.
 *
 * Only the parts that can be decided without a browser are covered here: the archive's
 * name, and the capability probe. The two save paths themselves end in a real file picker
 * or a real download — one is a native dialog no test can drive, the other is covered by
 * the end-to-end suite, which asserts the archive really unpacks into the pair.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('zipNameFor', () => {
  it('按主文件名取名，且换掉它自己的扩展名', () => {
    expect(
      zipNameFor([
        { blob: new Blob(), name: 'clip.jpg' },
        { blob: new Blob(), name: 'clip.mov' },
      ]),
    ).toBe('clip.zip');
  });

  it('没有扩展名也不会出现空名', () => {
    expect(zipNameFor([{ blob: new Blob(), name: 'clip' }])).toBe('clip.zip');
  });
});

describe('canSaveToFolder', () => {
  it('平台没有目录选择器时如实说不行', () => {
    vi.stubGlobal('window', {});
    expect(canSaveToFolder()).toBe(false);
  });

  it('有就说有', () => {
    vi.stubGlobal('window', { showDirectoryPicker: () => Promise.resolve({}) });
    expect(canSaveToFolder()).toBe(true);
  });
});
