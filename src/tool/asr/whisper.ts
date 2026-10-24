// Whisper 识别器：用 transformers.js（Apache-2.0）在应用内通过 onnxruntime-web 的 WASM 后端推理，完全离线。
// 模型文件由 models.ts 取得后交给这里，通过自定义缓存喂给 transformers.js，所以不会产生任何网络请求。
import { env, pipeline } from '@huggingface/transformers';
import type { RawPiece, Recognize } from './types';

const HOST = 'https://models.invalid/';

let current: Map<string, Uint8Array> = new Map();

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remoteHost = HOST;
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  async match(key: string) {
    const m = /\/resolve\/[^/]+\/(.+)$/.exec(key);
    const data = m ? current.get(decodeURIComponent(m[1])) : undefined;
    return data ? new Response(data as BlobPart, { status: 200, headers: { 'content-length': String(data.length) } }) : undefined;
  },
  async put() {},
} as unknown as typeof env.customCache;

/** 推理引擎的 wasm 文件由调用方提供（随应用打包的本地地址），避免从网上取 */
export function configureRuntime(paths: { wasm: string; mjs: string }) {
  const wasm = env.backends.onnx.wasm!;
  wasm.wasmPaths = paths;
  wasm.numThreads = 1; // 没有跨源隔离时无法用多线程
  wasm.proxy = true;
}

interface Asr {
  (audio: Float32Array, opt: Record<string, unknown>): Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
}

let loaded: { key: string; asr: Promise<Asr> } | null = null;

/** 载入识别器；同一批模型文件重复调用会复用 */
export function loadWhisper(modelKey: string, files: Map<string, Uint8Array>, repo: string): Promise<Asr> {
  if (loaded?.key === modelKey) return loaded.asr;
  current = files;
  const asr = pipeline('automatic-speech-recognition', repo, { dtype: 'q8', device: 'wasm' } as never)
    .then((p) => p as unknown as Asr)
    .catch((e) => {
      loaded = null;
      throw new Error(`识别模型加载失败：${e instanceof Error ? e.message : e}`);
    });
  loaded = { key: modelKey, asr };
  return asr;
}

/** 生成 transformers.js 的识别函数；language 为空则让模型自动判断语言 */
export function makeRecognizer(asr: Asr): Recognize {
  return async (audio, opt) => {
    const out = await asr(audio, {
      return_timestamps: true,
      task: 'transcribe',
      ...(opt.language ? { language: opt.language } : {}),
      chunk_length_s: 0,
    });
    const chunks = out.chunks ?? [];
    if (!chunks.length && out.text.trim()) return [{ text: out.text, start: 0, end: audio.length / 16000 }];
    return chunks.map((c): RawPiece => ({ text: c.text, start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? null }));
  };
}
