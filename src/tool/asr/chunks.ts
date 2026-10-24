// 长音频分段：按 30 秒一段，尽量把切点放在附近最安静的地方，避免把一个字切成两半。
import { SAMPLE_RATE } from './types';

export interface Chunk {
  /** 起止采样点（左闭右开） */
  from: number;
  to: number;
}

export const CHUNK_SECONDS = 30;
/** 切点只在每段最后这么多秒内寻找 */
const SEARCH_SECONDS = 5;
const FRAME = SAMPLE_RATE / 10; // 100ms 一帧

/** 在 [lo, hi) 里找能量最小的 100ms 帧，返回其中点；音频不足一帧时返回 hi */
export function quietestPoint(samples: Float32Array, lo: number, hi: number): number {
  let best = hi;
  let bestE = Infinity;
  for (let s = lo; s + FRAME <= hi; s += FRAME / 2) {
    let e = 0;
    for (let i = s; i < s + FRAME; i++) e += samples[i] * samples[i];
    if (e < bestE) {
      bestE = e;
      best = s + FRAME / 2;
    }
  }
  return Math.min(Math.round(best), hi);
}

/** 把整段音频切成若干段，每段不超过 chunkSeconds 秒，首尾相接、不重叠、不遗漏 */
export function planChunks(samples: Float32Array, chunkSeconds = CHUNK_SECONDS): Chunk[] {
  const max = Math.round(chunkSeconds * SAMPLE_RATE);
  const out: Chunk[] = [];
  let from = 0;
  while (from < samples.length) {
    if (samples.length - from <= max) {
      out.push({ from, to: samples.length });
      break;
    }
    const hi = from + max;
    const to = quietestPoint(samples, hi - SEARCH_SECONDS * SAMPLE_RATE, hi);
    out.push({ from, to: Math.max(to, from + 1) });
    from = Math.max(to, from + 1);
  }
  return out;
}

/** 这一段几乎全是静音（均方根低于阈值）时返回 true：静音段直接跳过，避免模型凭空编出文字 */
export function isSilent(samples: Float32Array, threshold = 0.004): boolean {
  if (samples.length === 0) return true;
  let e = 0;
  for (let i = 0; i < samples.length; i++) e += samples[i] * samples[i];
  return Math.sqrt(e / samples.length) < threshold;
}
