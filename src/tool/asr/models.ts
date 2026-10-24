// 模型文件管理：Whisper 的 ONNX 权重首次使用时下载到应用数据目录，逐个文件校验 SHA-256 后缓存。
// 网络、文件读写都通过参数传入，便于不联网测试。
//
// 权重来源：Hugging Face 上 Xenova/whisper-base、Xenova/whisper-small（transformers.js 作者转换的 ONNX 版，
// 模型卡标注 Apache-2.0；原始权重来自 OpenAI Whisper，GitHub 仓库为 MIT）。下载地址固定到某个提交，
// SHA-256 为下载后自行计算，文件大小与 Hugging Face 页面一致。这里用的是 8 位量化版（encoder / decoder_merged 各一个文件）。

export interface ModelFile {
  /** 相对模型目录的路径，同时也是 transformers.js 请求的文件名 */
  name: string;
  size: number;
  sha256: string;
}

export interface ModelSpec {
  id: 'base' | 'small';
  label: string;
  repo: string;
  commit: string;
  files: ModelFile[];
}

const COMMON = (sha: { config: string; gen: string }, sizes: { config: number; gen: number }): ModelFile[] => [
  { name: 'config.json', size: sizes.config, sha256: sha.config },
  { name: 'generation_config.json', size: sizes.gen, sha256: sha.gen },
  { name: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
  { name: 'tokenizer.json', size: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
  { name: 'tokenizer_config.json', size: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
];

export const MODELS: ModelSpec[] = [
  {
    id: 'base', label: '快速（约 76 MB，错字和漏句较多）', repo: 'Xenova/whisper-base', commit: '64da57285918e20ea79ea5c88eed7197933abaa8',
    files: [
      ...COMMON({ config: 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b', gen: '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05' }, { config: 2248, gen: 3776 }),
      { name: 'onnx/encoder_model_quantized.onnx', size: 23200850, sha256: '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9' },
      { name: 'onnx/decoder_model_merged_quantized.onnx', size: 53707539, sha256: 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861' },
    ],
  },
  {
    id: 'small', label: '推荐（约 240 MB，更准，速度约慢 4 倍）', repo: 'Xenova/whisper-small', commit: '2d67713f236afa48a18992566e7647f6ca848e13',
    files: [
      ...COMMON({ config: '5a6429d21d7a3379dd0861b74510f9f7076f32b563bffc9fcb072482d55ab3be', gen: '0b7407a4e53a677f826e03c75d409e6f830663932bf43dda3b08c5efa2223279' }, { config: 2232, gen: 3837 }),
      { name: 'onnx/encoder_model_quantized.onnx', size: 92324809, sha256: '969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06' },
      { name: 'onnx/decoder_model_merged_quantized.onnx', size: 156780950, sha256: 'fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24' },
    ],
  },
];

export const modelById = (id: string): ModelSpec => MODELS.find((m) => m.id === id) ?? MODELS[0];
export const modelTotalSize = (m: ModelSpec) => m.files.reduce((n, f) => n + f.size, 0);
export const fileUrl = (m: ModelSpec, f: ModelFile) => `https://huggingface.co/${m.repo}/resolve/${m.commit}/${f.name}`;

export interface FetchedResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export interface ModelDeps {
  fetch(url: string, init: { signal?: AbortSignal }): Promise<FetchedResponse>;
  /** 读文件，不存在返回 null */
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  join(...parts: string[]): string | Promise<string>;
  sha256(data: Uint8Array): Promise<string>;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 流式下载并回报已下载字节数；长度不对或连接中断都抛出带原因的错误 */
export async function downloadBytes(
  fetchFn: ModelDeps['fetch'], url: string, expectedSize: number, onBytes: (n: number) => void, signal?: AbortSignal,
): Promise<Uint8Array> {
  let res: FetchedResponse;
  try {
    res = await fetchFn(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw new Error('已取消');
    throw new Error(`连不上模型下载地址（${e instanceof Error ? e.message : e}）。可以换个网络重试，或手动下载模型后在「模型」里选择本地模型文件夹`);
  }
  if (!res.ok || !res.body) throw new Error(`模型下载失败（服务器返回 ${res.status}）`);
  const buf = new Uint8Array(expectedSize);
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > expectedSize) throw new Error('下载内容比预期的大，已中止');
      buf.set(value, got);
      got += value.length;
      onBytes(got);
    }
  } catch (e) {
    if (signal?.aborted) throw new Error('已取消');
    throw new Error(`下载中断：${e instanceof Error ? e.message : e}`);
  }
  if (got !== expectedSize) throw new Error(`下载不完整（收到 ${got} 字节，应为 ${expectedSize}）`);
  return buf;
}

export interface LoadOptions {
  /** 应用数据目录下存放模型的根目录，每个模型一个子文件夹 */
  cacheRoot: string;
  /** 手动指定的本地模型文件夹：里面要有和下载版相同的文件（含 onnx 子文件夹） */
  localDir?: string;
  /** 总进度 0–1，只在真正下载时回调 */
  onDownload?: (ratio: number) => void;
  signal?: AbortSignal;
}

/**
 * 取得一个模型的全部文件（文件名 → 字节）：
 * 1. 指定了本地文件夹 → 逐个读取并校验，不联网；缺文件或校验不过就报出具体是哪个；
 * 2. 缓存里的文件校验通过 → 直接用；
 * 3. 否则逐个下载 → 校验 → 写入缓存。
 */
export async function loadModelFiles(deps: ModelDeps, spec: ModelSpec, opt: LoadOptions): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const root = opt.localDir ?? (await deps.join(opt.cacheRoot, spec.id));
  const total = modelTotalSize(spec);
  let done = 0;
  for (const f of spec.files) {
    if (opt.signal?.aborted) throw new Error('已取消');
    const path = await deps.join(root, ...f.name.split('/'));
    const have = await deps.read(path);
    if (have && have.length === f.size && (await deps.sha256(have)) === f.sha256) {
      out.set(f.name, have);
      done += f.size;
      continue;
    }
    if (opt.localDir) {
      if (!have) throw new Error(`指定的模型文件夹里缺少 ${f.name}（需要 ${spec.repo} 的同名文件）`);
      throw new Error(`指定的模型文件夹里的 ${f.name} 校验不通过，不是本工具需要的 ${spec.repo} 文件`);
    }
    const base = done;
    const data = await downloadBytes(deps.fetch, fileUrl(spec, f), f.size, (n) => opt.onDownload?.((base + n) / total), opt.signal);
    if ((await deps.sha256(data)) !== f.sha256) throw new Error(`${f.name} 下载后校验不通过（文件可能被篡改或下载出错），请重试`);
    await deps.write(path, data);
    out.set(f.name, data);
    done += f.size;
  }
  return out;
}
