// 识别结果整理：时间戳还原到整段音频、去重复幻觉、拆过长字幕、文本后处理。纯函数。
import type { RawPiece, Segment } from './types';

/** 英文有时会在单词中间被切成两个片段（「ro」「om.」）：前一片段以字母结尾、后一片段以字母开头且没有空格时，并回一个片段 */
export function joinWordBreaks(pieces: RawPiece[]): RawPiece[] {
  const out: RawPiece[] = [];
  for (const p of pieces) {
    const prev = out[out.length - 1];
    if (prev && /[A-Za-z]$/.test(prev.text) && /^[A-Za-z]/.test(p.text)) out[out.length - 1] = { text: prev.text + p.text, start: prev.start, end: p.end };
    else out.push({ ...p });
  }
  return out;
}

/** 把窗口内的片段平移到整段音频的时间轴，补全缺失的结束时间，并限制在窗口范围内 */
export function offsetPieces(pieces: RawPiece[], windowStart: number, windowEnd: number): Segment[] {
  const out: Segment[] = [];
  pieces = joinWordBreaks(pieces);
  pieces.forEach((p, i) => {
    const text = p.text.trim();
    if (!text) return;
    const start = Math.min(Math.max(windowStart + p.start, windowStart), windowEnd);
    // 缺失结束时间：用下一片段的开头，最后一片用窗口末尾
    const next = pieces[i + 1];
    const rawEnd = windowStart + (p.end ?? (next ? next.start : windowEnd - windowStart));
    const end = Math.min(Math.max(rawEnd, start), windowEnd);
    out.push({ start, end, text });
  });
  return out;
}

const PUNCT_BREAK = /[。！？!?；;，,、…]/;
const isCjk = (c: string) => /[㐀-鿿豈-﫿]/.test(c);

/** 一行的显示宽度：中日韩字符算 1，其他字符算 0.5 */
export function textWidth(t: string): number {
  let w = 0;
  for (const c of t) w += isCjk(c) ? 1 : 0.5;
  return w;
}

/**
 * 文本后处理：去首尾空白、合并多余空格、中文字之间的空格去掉、压缩「啊啊啊啊」之类的长重复。
 * 不改动用词，也不做繁简转换。
 */
export function cleanText(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/(?<=[㐀-鿿，。！？、；：”）》]) (?=[㐀-鿿“（《])/g, '');
  t = t.replace(/(.{1,4}?)\1{5,}/gu, '$1$1$1'); // 同一个词连续重复 6 次以上，保留 3 次
  return t;
}

/** 按标点把过长的字幕拆成多条，时间按字数比例分配；maxWidth 为一条字幕最大宽度（中文字数） */
export function splitLong(seg: Segment, maxWidth: number): Segment[] {
  if (textWidth(seg.text) <= maxWidth) return [seg];
  // 先切成「带标点结尾」的小句
  const clauses: string[] = [];
  let cur = '';
  for (const c of seg.text) {
    cur += c;
    if (PUNCT_BREAK.test(c)) {
      clauses.push(cur);
      cur = '';
    }
  }
  if (cur) clauses.push(cur);
  // 贪心合并小句，每条不超过 maxWidth；单个小句仍超长则硬切
  const lines: string[] = [];
  let line = '';
  const flush = () => {
    if (line) lines.push(line);
    line = '';
  };
  for (const cl of clauses) {
    if (textWidth(cl) > maxWidth) {
      flush();
      let piece = '';
      // 平均分成 n 行，避免最后一行只剩一两个字
      const limit = (textWidth(cl) / Math.ceil(textWidth(cl) / maxWidth)) * 1.15;
      // 按「一个汉字」或「一个英文单词」为单位硬切，不会把单词切开
      for (const tok of cl.match(/[\u3400-\u9fff]|[^\s\u3400-\u9fff]+\s*/gu) ?? []) {
        if (piece && textWidth(piece + tok) > Math.min(maxWidth, limit)) {
          lines.push(piece);
          piece = '';
        }
        piece += tok;
      }
      line = piece;
    } else if (textWidth(line + cl) > maxWidth) {
      flush();
      line = cl;
    } else line += cl;
  }
  flush();
  const total = lines.reduce((n, l) => n + textWidth(l), 0) || 1;
  const dur = seg.end - seg.start;
  let acc = 0;
  return lines.map((l) => {
    const start = seg.start + (dur * acc) / total;
    acc += textWidth(l);
    const end = seg.start + (dur * acc) / total;
    return { start, end, text: l.trim() };
  });
}

/** 合并所有窗口的结果：按时间排序、丢弃空文本、去掉连续 3 次以上完全相同的句子（模型卡住时的常见幻觉）、保证不重叠 */
export function finalize(segs: Segment[], opt: { maxWidth?: number; minDuration?: number } = {}): Segment[] {
  const maxWidth = opt.maxWidth ?? 24;
  const minDur = opt.minDuration ?? 0.4;
  const sorted = segs
    .map((s) => ({ ...s, text: cleanText(s.text) }))
    .filter((s) => s.text)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const dedup: Segment[] = [];
  for (const s of sorted) {
    const n = dedup.length;
    if (n >= 2 && dedup[n - 1].text === s.text && dedup[n - 2].text === s.text) continue;
    dedup.push(s);
  }
  // 每条字幕行尾的逗号、顿号不要
  const out = dedup.flatMap((s) => splitLong(s, maxWidth)).map((s) => ({ ...s, text: s.text.replace(/[，、,]+$/u, '') }));
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (i > 0 && s.start < out[i - 1].end) s.start = out[i - 1].end;
    if (s.end < s.start + minDur) s.end = s.start + minDur;
    const nx = out[i + 1];
    if (nx && s.end > nx.start) s.end = Math.max(s.start, nx.start);
  }
  return out.filter((s) => s.end > s.start);
}
