// 字幕格式：SRT / 纯文本 的生成与解析，纯函数。
import type { Segment } from './types';

/** 秒 → 00:01:02,345 */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms % 1000, 3)}`;
}

/** 界面上显示 / 编辑用的时间：1:02.345；满一小时为 1:02:03.456 */
export function shortTime(sec: number): string {
  const [hms, ms] = srtTime(sec).split(',');
  const [h, m, s] = hms.split(':');
  return Number(h) ? `${Number(h)}:${m}:${s}.${ms}` : `${Number(m)}:${s}.${ms}`;
}

/** 解析界面输入的时间，支持 1.5、12.345、1:02.5、1:02:03.5、00:00:01,500；写错返回 null */
export function parseTime(input: string): number | null {
  const s = input.trim().replace(',', '.');
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Number.isFinite(sec) ? sec : null;
}

export function toSrt(segments: Segment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`)
    .join('\n');
}

/** 纯文本：每条字幕一行，不带时间 */
export function toTxt(segments: Segment[]): string {
  return segments.map((s) => s.text.trim()).filter(Boolean).join('\n') + '\n';
}

/** 读回 SRT（用于核对导出结果；也方便后续支持导入已有字幕） */
export function parseSrt(text: string): Segment[] {
  const out: Segment[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.length);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->').map((x) => parseTime(x));
    if (a == null || b == null) continue;
    out.push({ start: a, end: b, text: lines.slice(ti + 1).join('\n') });
  }
  return out;
}
