// 流程测试：假识别函数 → 转写 → 质检，不需要模型，也不联网。
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, transcribe, type Recognize } from './asr';
import { evaluate, problems } from './core';
import { DEFAULT_CONFIG } from './samples';

const samples = new Float32Array(45 * SAMPLE_RATE).fill(0.2);

describe('转写后质检', () => {
  it('第二个 30 秒窗口里的话，时间戳平移后参与「限前 N 秒」判断', async () => {
    // 窗口 1 只说"喂"，"您好"在第二个窗口里，实际时间 20 多秒之后 → 超过「开场问候」的 15 秒限制
    let call = 0;
    const fake: Recognize = async () => (call++ === 0 ? [{ text: '喂', start: 1, end: 2 }] : [{ text: '您好，这里是客服中心，感谢您的来电，再见', start: 1, end: 8 }]);
    const segs = await transcribe(samples, fake, { language: 'chinese' });
    expect(segs.find((s) => s.text.includes('您好'))!.start).toBeGreaterThan(20);
    const report = evaluate(segs, DEFAULT_CONFIG);
    expect(problems(report)).toContain('未按时说「开场问候（示例）」');
    expect(report.results.find((r) => r.rule.id === 'd3')!.failed).toBe(false);
  });
  it('静音窗口不调用识别函数，也不会误报', async () => {
    let calls = 0;
    const out = await transcribe(new Float32Array(10 * SAMPLE_RATE), async () => { calls++; return []; }, { language: 'chinese' });
    expect(calls).toBe(0);
    expect(out).toEqual([]);
    expect(evaluate(out, DEFAULT_CONFIG).score).toBe(100 - 15 - 15 - 10);
  });
});
