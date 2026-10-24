// 字幕编辑操作：删除、与下一条合并、拆分、全文替换、检查问题。纯函数，不修改传入的数组。
import { textWidth } from './merge';
import type { Segment } from './types';

export const removeAt = (segs: Segment[], i: number): Segment[] => segs.filter((_, k) => k !== i);

/** 第 i 条与下一条合并：时间取两者外沿，文字连起来（中文直接连，英文补空格） */
export function mergeNext(segs: Segment[], i: number): Segment[] {
  const a = segs[i];
  const b = segs[i + 1];
  if (!a || !b) return segs;
  const glue = /[A-Za-z0-9,.!?;:]$/.test(a.text) && /^[A-Za-z0-9]/.test(b.text) ? ' ' : '';
  const merged = { start: a.start, end: Math.max(a.end, b.end), text: a.text.trim() + glue + b.text.trim() };
  return [...segs.slice(0, i), merged, ...segs.slice(i + 2)];
}

/** 在文字的第 at 个字符处把第 i 条拆成两条，时间按字数比例分；位置在两端时不动 */
export function splitAt(segs: Segment[], i: number, at: number): Segment[] {
  const s = segs[i];
  if (!s || at <= 0 || at >= s.text.length) return segs;
  const left = s.text.slice(0, at).trim();
  const right = s.text.slice(at).trim();
  if (!left || !right) return segs;
  const ratio = textWidth(left) / (textWidth(left) + textWidth(right));
  const mid = s.start + (s.end - s.start) * ratio;
  return [...segs.slice(0, i), { start: s.start, end: mid, text: left }, { start: mid, end: s.end, text: right }, ...segs.slice(i + 1)];
}

/** 全文替换（按字面文字，不用正则）；返回新数组和被替换的处数 */
export function replaceAll(segs: Segment[], find: string, to: string): { segs: Segment[]; count: number } {
  if (!find) return { segs, count: 0 };
  let count = 0;
  const out = segs.map((s) => {
    const parts = s.text.split(find);
    count += parts.length - 1;
    return parts.length > 1 ? { ...s, text: parts.join(to) } : s;
  });
  return { segs: out, count };
}

export interface Issue {
  index: number;
  kind: 'order' | 'overlap' | 'empty';
  message: string;
}

/** 导出前检查：结束时间不晚于开始、与上一条重叠、文字为空 */
export function checkSegments(segs: Segment[]): Issue[] {
  const out: Issue[] = [];
  segs.forEach((s, i) => {
    if (!s.text.trim()) out.push({ index: i, kind: 'empty', message: '文字是空的，导出时会留下一条空字幕' });
    if (s.end <= s.start) out.push({ index: i, kind: 'order', message: '结束时间要晚于开始时间' });
    if (i > 0 && s.start < segs[i - 1].end - 0.001) out.push({ index: i, kind: 'overlap', message: '开始时间早于上一条的结束时间' });
  });
  return out;
}
