// 转写流程：分段 → 逐段识别 → 还原时间戳 → 整理。识别函数由外部传入，测试里用假函数，不联网、不需要模型。
import { isSilent, planChunks } from './chunks';
import { finalize, offsetPieces } from './merge';
import { SAMPLE_RATE, type Recognize, type Segment } from './types';

export interface TranscribeOptions {
  /** whisper 语言名，如 chinese / english；空字符串为自动识别 */
  language: string;
  /** 一条字幕最大宽度（中文字数），默认 24 */
  maxWidth?: number;
  /** 进度回调：已完成段数 / 总段数 */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** 对每条识别出的文字再加工（例如繁体转简体）；不填则原样保留 */
  postText?: (text: string) => string;
}

export async function transcribe(samples: Float32Array, recognize: Recognize, opt: TranscribeOptions): Promise<Segment[]> {
  const chunks = planChunks(samples);
  const all: Segment[] = [];
  opt.onProgress?.(0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    if (opt.signal?.aborted) throw new Error('已取消');
    const c = chunks[i];
    const audio = samples.subarray(c.from, c.to);
    if (!isSilent(audio)) {
      const pieces = await recognize(audio, { language: opt.language });
      all.push(...offsetPieces(pieces, c.from / SAMPLE_RATE, c.to / SAMPLE_RATE));
    }
    opt.onProgress?.(i + 1, chunks.length);
  }
  const post = opt.postText;
  return finalize(post ? all.map((s) => ({ ...s, text: post(s.text) })) : all, { maxWidth: opt.maxWidth });
}
