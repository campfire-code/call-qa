import { describe, expect, it } from 'vitest';
import { MODELS, downloadBytes, fileUrl, loadModelFiles, modelById, modelTotalSize, sha256Hex, type ModelDeps, type ModelSpec } from './models';
import { extractAudio } from './extract';

const enc = (s: string) => new TextEncoder().encode(s);

async function makeSpec(contents: Record<string, string>): Promise<ModelSpec> {
  const files = [];
  for (const [name, text] of Object.entries(contents)) files.push({ name, size: enc(text).length, sha256: await sha256Hex(enc(text)) });
  return { id: 'base', label: 't', repo: 'x/y', commit: 'abc', files };
}

function fakeDeps(remote: Record<string, string>, disk = new Map<string, Uint8Array>()) {
  const fetched: string[] = [];
  const deps: ModelDeps = {
    async fetch(url) {
      fetched.push(url);
      const name = decodeURIComponent(url.split('/resolve/abc/')[1]);
      if (!(name in remote)) return { ok: false, status: 404, headers: { get: () => null }, body: null };
      const data = enc(remote[name]);
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data.subarray(0, 2)); c.enqueue(data.subarray(2)); c.close(); } });
      return { ok: true, status: 200, headers: { get: () => String(data.length) }, body };
    },
    async read(p) { return disk.get(p) ?? null; },
    async write(p, d) { disk.set(p, d); },
    join: (...parts) => parts.join('/'),
    sha256: sha256Hex,
  };
  return { deps, fetched, disk };
}

describe('模型清单', () => {
  it('两个模型的文件齐全，下载地址固定到提交', () => {
    expect(MODELS.map((m) => m.id)).toEqual(['base', 'small']);
    for (const m of MODELS) {
      expect(m.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(m.files.map((f) => f.name)).toEqual(expect.arrayContaining(['config.json', 'tokenizer.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']));
      m.files.forEach((f) => expect(f.sha256).toMatch(/^[0-9a-f]{64}$/));
      expect(fileUrl(m, m.files[0])).toBe(`https://huggingface.co/${m.repo}/resolve/${m.commit}/config.json`);
    }
    expect(modelTotalSize(modelById('base'))).toBeLessThan(80_000_000);
    expect(modelById('未知').id).toBe('base');
  });
});

describe('模型下载与缓存', () => {
  it('首次使用：下载、校验、写入缓存并回报进度；第二次直接用缓存不联网', async () => {
    const remote = { 'a.json': 'hello', 'onnx/m.onnx': 'world-model' };
    const spec = await makeSpec(remote);
    const { deps, fetched, disk } = fakeDeps(remote);
    const ratios: number[] = [];
    const files = await loadModelFiles(deps, spec, { cacheRoot: '/data/models', onDownload: (r) => ratios.push(r) });
    expect(files.size).toBe(2);
    expect(fetched).toHaveLength(2);
    expect(disk.has('/data/models/base/onnx/m.onnx')).toBe(true);
    expect(ratios.at(-1)).toBeCloseTo(1);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    const again = fakeDeps({}, disk);
    await loadModelFiles(again.deps, spec, { cacheRoot: '/data/models' });
    expect(again.fetched).toHaveLength(0);
  });
  it('缓存文件损坏时重新下载', async () => {
    const remote = { 'a.json': 'hello' };
    const spec = await makeSpec(remote);
    const disk = new Map([['/c/base/a.json', enc('hellX')]]);
    const { deps, fetched } = fakeDeps(remote, disk);
    const files = await loadModelFiles(deps, spec, { cacheRoot: '/c' });
    expect(fetched).toHaveLength(1);
    expect(new TextDecoder().decode(files.get('a.json'))).toBe('hello');
  });
  it('下载内容被篡改：校验不通过，不写缓存', async () => {
    const spec = await makeSpec({ 'a.json': 'hello' });
    const { deps, disk } = fakeDeps({ 'a.json': 'HELLO' });
    await expect(loadModelFiles(deps, spec, { cacheRoot: '/c' })).rejects.toThrow('校验不通过');
    expect(disk.size).toBe(0);
  });
  it('服务器 404 / 长度不符 / 网络不通都有清楚的中文错误', async () => {
    const spec = await makeSpec({ 'a.json': 'hello' });
    await expect(loadModelFiles(fakeDeps({}).deps, spec, { cacheRoot: '/c' })).rejects.toThrow('服务器返回 404');
    await expect(loadModelFiles(fakeDeps({ 'a.json': 'hi' }).deps, spec, { cacheRoot: '/c' })).rejects.toThrow('下载不完整');
    const offline = fakeDeps({}).deps;
    offline.fetch = async () => { throw new Error('network down'); };
    await expect(loadModelFiles(offline, spec, { cacheRoot: '/c' })).rejects.toThrow('手动下载模型');
  });
  it('取消下载', async () => {
    const spec = await makeSpec({ 'a.json': 'hello' });
    const ac = new AbortController();
    ac.abort();
    await expect(loadModelFiles(fakeDeps({ 'a.json': 'hello' }).deps, spec, { cacheRoot: '/c', signal: ac.signal })).rejects.toThrow('已取消');
  });
  it('指定本地模型文件夹：只读本地、不联网；缺文件、校验不过分别报错', async () => {
    const remote = { 'a.json': 'hello', 'onnx/m.onnx': 'world-model' };
    const spec = await makeSpec(remote);
    const disk = new Map([['/my/a.json', enc('hello')], ['/my/onnx/m.onnx', enc('world-model')]]);
    const ok = fakeDeps({}, disk);
    expect((await loadModelFiles(ok.deps, spec, { cacheRoot: '/c', localDir: '/my' })).size).toBe(2);
    expect(ok.fetched).toHaveLength(0);
    disk.delete('/my/onnx/m.onnx');
    await expect(loadModelFiles(fakeDeps({}, disk).deps, spec, { cacheRoot: '/c', localDir: '/my' })).rejects.toThrow('缺少 onnx/m.onnx');
    disk.set('/my/onnx/m.onnx', enc('world-modeX'));
    await expect(loadModelFiles(fakeDeps({}, disk).deps, spec, { cacheRoot: '/c', localDir: '/my' })).rejects.toThrow('校验不通过');
  });
  it('下载内容比预期大时中止', async () => {
    const f = fakeDeps({ 'a.json': 'hello-too-long' }).deps.fetch;
    await expect(downloadBytes(f, 'https://x/resolve/abc/a.json', 5, () => {})).rejects.toThrow('比预期的大');
  });
});

describe('抽音频流程', () => {
  const wav = (() => {
    const b = new Uint8Array(44 + 4);
    const dv = new DataView(b.buffer);
    [...'RIFF'].forEach((c, i) => (b[i] = c.charCodeAt(0)));
    [...'WAVEfmt '].forEach((c, i) => (b[8 + i] = c.charCodeAt(0)));
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    [...'data'].forEach((c, i) => (b[36 + i] = c.charCodeAt(0)));
    dv.setUint32(40, 4, true); dv.setInt16(44, 16384, true); dv.setInt16(46, -16384, true);
    return b;
  })();
  it('转换后读入采样并删除临时文件', async () => {
    const removed: string[] = [];
    let args: string[] = [];
    const s = await extractAudio({ ffmpeg: async (a, onTime) => { args = a; onTime?.(3); }, readFile: async () => wav, remove: async (p) => void removed.push(p) }, '/v.mp4', '/tmp/x.wav', () => {});
    expect(Array.from(s)).toEqual([0.5, -0.5]);
    expect(args[1]).toBe('/v.mp4');
    expect(removed).toEqual(['/tmp/x.wav']);
  });
  it('ffmpeg 失败也要清理临时文件并把错误抛出', async () => {
    const removed: string[] = [];
    await expect(extractAudio({ ffmpeg: async () => { throw new Error('ffmpeg 处理失败：无音轨'); }, readFile: async () => wav, remove: async (p) => void removed.push(p) }, '/v.mp4', '/tmp/x.wav')).rejects.toThrow('无音轨');
    expect(removed).toEqual(['/tmp/x.wav']);
  });
});
