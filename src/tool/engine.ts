// 把 asr 模块接到 Tauri 的本机能力上：下载模型、抽音频、加载识别器。界面只调用这里。
import { appDataDir, join, tempDir } from '@tauri-apps/api/path';
import { exists, mkdir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import { httpFetch } from '../kit/platform';
import type { RunContext } from '../kit/types';
import { extractAudio, loadModelFiles, modelById, polishChinese, sha256Hex, transcribe, type ModelDeps, type Segment } from './asr';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';

type Ctx = Pick<RunContext, 'ffmpeg' | 'duration'>;

export interface Job {
  path: string;
  model: string;
  /** whisper 语言名：chinese / english */
  language: 'chinese' | 'english';
  /** 中文结果转简体并规范标点 */
  simplified: boolean;
  /** 一条文字的最大宽度（中文字数） */
  maxWidth: number;
  /** 手动指定的本地模型文件夹，空则自动下载 */
  localDir: string;
}

export type Stage = { step: 'extract' | 'download' | 'load' | 'recognize'; ratio: number; text: string };

const deps: ModelDeps = {
  fetch: (url, init) => httpFetch(url, { method: 'GET', signal: init.signal }) as unknown as ReturnType<ModelDeps['fetch']>,
  read: async (p) => ((await exists(p)) ? readFile(p) : null),
  write: async (p, d) => {
    await mkdir(p.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    await writeFile(p, d);
  },
  join,
  sha256: sha256Hex,
};

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'amr', 'awb', '3gp'];

export async function runJob(ctx: Ctx, job: Job, onStage: (s: Stage) => void, signal: AbortSignal): Promise<{ segments: Segment[]; duration: number }> {
  const spec = modelById(job.model);
  // 1. 抽音频
  onStage({ step: 'extract', ratio: 0, text: '正在读取录音…' });
  const total = await ctx.duration(job.path).catch(() => 0);
  const tmp = await join(await tempDir(), `call-qa-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
  const samples = await extractAudio(
    { ffmpeg: (a, t) => ctx.ffmpeg(a, t), readFile, remove },
    job.path, tmp,
    (s) => onStage({ step: 'extract', ratio: total ? Math.min(1, s / total) : 0, text: '正在读取录音…' }),
  );
  if (signal.aborted) throw new Error('已取消');
  if (samples.length < 16000 * 0.5) throw new Error('这段录音里没有可识别的声音（不足半秒）');

  // 2. 模型：本地文件夹 / 缓存 / 下载
  onStage({ step: 'download', ratio: 0, text: '正在准备识别模型…' });
  const files = await loadModelFiles(deps, spec, {
    cacheRoot: await join(await appDataDir(), 'models', 'whisper'),
    localDir: job.localDir || undefined,
    onDownload: (r) => onStage({ step: 'download', ratio: r, text: `首次使用，正在下载识别模型（${spec.id === 'base' ? '约 76' : '约 240'} MB）…` }),
    signal,
  });
  onStage({ step: 'load', ratio: 0, text: '正在加载识别模型…' });
  const w = await import('./asr/whisper');
  w.configureRuntime({ wasm: wasmUrl, mjs: mjsUrl });
  const asr = await w.loadWhisper(`${job.model}|${job.localDir}`, files, spec.repo);

  // 3. 分段识别
  const segments = await transcribe(samples, w.makeRecognizer(asr), {
    language: job.language,
    maxWidth: job.maxWidth,
    postText: job.language === 'chinese' && job.simplified ? polishChinese : undefined,
    signal,
    onProgress: (d, t) => onStage({ step: 'recognize', ratio: t ? d / t : 1, text: `正在识别：第 ${Math.min(d + 1, t)} / ${t} 段` }),
  });
  if (!segments.length) throw new Error('没有识别到说话内容。可能是静音 / 噪声，或语言选错了');
  return { segments, duration: total || samples.length / 16000 };
}
