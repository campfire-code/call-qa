// 用本机真实的内置 ffmpeg 验证各种录音格式能解码成可识别的音频；没有可运行的 ffmpeg（例如其他平台）时自动跳过。
// 设置环境变量 AMR_SAMPLE=某个 .amr 文件路径，可额外验证 AMR 解码（仓库里没放 AMR 示例：本机没有 AMR 编码器，无法自己合成）。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractAudio } from './asr';

const bin = fileURLToPath(new URL('../../src-tauri/binaries/ffmpeg-aarch64-apple-darwin', import.meta.url));
const sample = (n: string) => fileURLToPath(new URL(`../../samples/${n}`, import.meta.url));
const runnable = process.platform === 'darwin' && process.arch === 'arm64' && existsSync(bin);

async function decode(path: string) {
  const out = `${tmpdir()}/o17-real-${Date.now()}.wav`;
  const samples = await extractAudio({
    ffmpeg: async (args) => void execFileSync(bin, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args]),
    readFile: async (p) => new Uint8Array(readFileSync(p)),
    remove: async (p) => rmSync(p, { force: true }),
  }, path, out);
  expect(existsSync(out)).toBe(false);
  return samples;
}

describe.skipIf(!runnable)('真实 ffmpeg 解码录音', () => {
  it.each([['示例通话A-合格.mp3', 28.9], ['示例通话B-违规.m4a', 15.5], ['示例通话C-漏说.wav', 19]])('%s → 16kHz 单声道，时长约 %f 秒', async (name, sec) => {
    const s = await decode(sample(name));
    expect(Math.abs(s.length / 16000 - sec)).toBeLessThan(0.5);
    expect(s.some((v) => Math.abs(v) > 0.05)).toBe(true);
  });
  it.skipIf(!process.env.AMR_SAMPLE)('AMR 文件能解码', async () => {
    const s = await decode(process.env.AMR_SAMPLE!);
    expect(s.length).toBeGreaterThan(16000);
  });
});
