// 抽音频流程：ffmpeg 转 16kHz 单声道 WAV 到临时文件 → 读入 → 删除临时文件。依赖都由参数传入。
import { extractArgs, parseWav } from './audio';

export interface ExtractDeps {
  ffmpeg(args: string[], onTime?: (seconds: number) => void): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
}

/** 返回 16kHz 单声道采样；onSeconds 收到已转换的秒数。无论成功失败都会清理临时文件。 */
export async function extractAudio(deps: ExtractDeps, input: string, tmpWav: string, onSeconds?: (s: number) => void): Promise<Float32Array> {
  try {
    await deps.ffmpeg(extractArgs(input, tmpWav), onSeconds);
    return parseWav(await deps.readFile(tmpWav)).samples;
  } finally {
    await deps.remove(tmpWav).catch(() => {});
  }
}
