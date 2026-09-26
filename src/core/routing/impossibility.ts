import type { FormatId, ImpossibilityReason } from '../types.ts';

export interface Impossibility {
  reason: ImpossibilityReason;
  /** Computed specifics, e.g. which codec is missing. */
  detail?: string;
  /**
   * Formats that WOULD work, so the UI can offer a real button instead of a dead end.
   * Empty only when nothing can be done — in which case the copy says so plainly.
   */
  alternatives: readonly FormatId[];
}

export interface ImpossibilityCopy {
  title: string;
  body: (i: Impossibility) => string;
}

/**
 * User-facing copy for every way a conversion can be unavailable.
 *
 * The strings are Chinese because the interface is; the code around them stays English.
 *
 * The guiding rule: a disabled control must explain *why*, and whenever a different
 * target would work, the UI offers that target as a button — alternatives are rendered
 * as controls, never folded into the prose.
 *
 * Where nothing can be done, we say so without hedging. Audio genuinely has no visual
 * component, and inventing one would be creation, not conversion.
 */
export const IMPOSSIBILITY_COPY: Record<ImpossibilityReason, ImpossibilityCopy> = {
  'class-mismatch': {
    title: '不适用于这个文件',
    body: () => '这个转换不适用于你拖入的文件类型。',
  },

  'needs-visual-component': {
    title: '音频没有画面',
    body: () =>
      '视频需要一条画面轨道，而音频里并不包含画面。在这里生成视频意味着凭空发明画面——' +
      '那是创作，不是转换。可以改选一种音频格式。',
  },

  'needs-motion-component': {
    title: '静态图没有运动',
    body: () =>
      'Live Photo 的定义是「一张静图 + 一段短片」。单张图片无法提供视频的那一半。' +
      '把配对的那段视频一起拖进来，我们就可以把它们组回一个 Live Photo。',
  },

  'needs-multiple-frames': {
    title: '单帧不构成动画',
    body: () =>
      '动图格式需要一串连续的帧。单张静图无法被拉伸成运动，除非凭空补出缺失的帧。' +
      '可以改选一种静图格式。',
  },

  'livephoto-needs-video': {
    title: 'Live Photo 还需要一段视频',
    body: () =>
      'Live Photo 由一张静图和一段共享标识的短片配对而成。只有静图时，没有视频的那一半可以配对。',
  },

  'no-encoder-in-browser': {
    title: '这个浏览器无法编码该格式',
    body: (i) =>
      `你的浏览器没有 ${i.detail ?? '所选格式'} 的编码器。这是浏览器的限制，` +
      '不是文件本身的问题。',
  },

  'no-decoder-in-browser': {
    title: '这个文件无法在此解码',
    body: (i) =>
      `你的浏览器无法解码 ${i.detail ?? '这个文件'}。可以换一个浏览器，` +
      '或先用桌面工具转换一次。',
  },

  'container-cannot-hold-codec': {
    title: '这个容器装不下该编码',
    body: (i) =>
      `${i.detail ?? '所选编码'} 无法存入所选容器。请换一种编码，或换一个容器。`,
  },

  'param-unsupported': {
    title: '该目标格式不支持这个设置',
    body: (i) => `${i.detail ?? '所请求的设置'} 无法被这个格式满足。`,
  },

  'engine-unavailable': {
    title: '所需引擎不可用',
    body: (i) =>
      `${i.detail ?? '这个转换所需的引擎'} 无法加载。通常是因为页面没有开启跨源隔离，` +
      '而兜底引擎需要它。',
  },
};
