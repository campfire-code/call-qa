// 抽音频：用内置 ffmpeg 把任意音视频转成 16kHz 单声道 16 位 WAV，再读成浮点采样。
import { SAMPLE_RATE } from './types';

/** ffmpeg 参数：丢掉视频流，转 16kHz 单声道 PCM WAV */
export function extractArgs(input: string, output: string): string[] {
  return ['-i', input, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', output];
}

/**
 * 解析 16 位 PCM WAV，返回 [-1, 1] 的浮点采样。
 * 只认 ffmpeg 输出的格式；找 fmt / data 块，兼容 LIST 等附加块，兼容流式输出时 data 长度写成 0 或超出的情况。
 */
export function parseWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('音频转换结果不是有效的 WAV 文件');
  let pos = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    let size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (sampleRate !== SAMPLE_RATE || channels !== 1 || bits !== 16) throw new Error(`音频格式不对（${sampleRate}Hz、${channels} 声道、${bits} 位），应为 16000Hz 单声道 16 位`);
      if (size === 0 || body + size > bytes.length) size = bytes.length - body;
      const n = Math.floor(size / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = dv.getInt16(body + i * 2, true) / 32768;
      return { samples, sampleRate };
    }
    pos = body + size + (size % 2);
  }
  throw new Error('音频转换结果里没有声音数据，这个文件可能没有音轨');
}
