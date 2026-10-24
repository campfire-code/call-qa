// 纯函数：质检规则匹配与计分。不依赖界面和本机能力，便于单元测试。
import type { Segment } from './asr';

export type Kind = 'required' | 'banned' | 'keyword';
export const KIND_NAME: Record<Kind, string> = { required: '必说话术', banned: '违禁 / 敏感词', keyword: '关键词统计' };

export interface Rule {
  id: string;
  kind: Kind;
  name: string;
  /** 词 / 同义词组：命中其中任意一个就算命中 */
  words: string[];
  /** 不达标时扣的分：必说=漏说扣分，违禁=命中即扣一次，关键词=次数不符时扣 */
  penalty: number;
  /** 必说话术：只认通话前 N 秒内说的，0 = 不限 */
  withinSec?: number;
  /** 关键词：至少出现几次，0 = 不要求 */
  min?: number;
  /** 关键词：最多出现几次，0 = 不限 */
  max?: number;
}

export interface Config {
  rules: Rule[];
  /** 及格分，得分不低于它为「合格」 */
  passScore: number;
}

export interface Hit {
  word: string;
  /** 命中所在那句话的开始时间（秒） */
  at: number;
  /** 命中所在的整句话 */
  context: string;
}

export interface RuleResult {
  rule: Rule;
  /** 命中次数（必说话术只数窗口内的） */
  count: number;
  hits: Hit[];
  /** 不达标：漏说 / 命中违禁词 / 次数不符 */
  failed: boolean;
  deduct: number;
  note: string;
}

export interface Report {
  score: number;
  passed: boolean;
  results: RuleResult[];
}

/** 把一行词（逗号、顿号、分号、竖线、换行分隔）拆成词组 */
export function parseWords(s: string): string[] {
  return [...new Set(s.split(/[,，、;；|｜\n]+/).map((w) => w.trim()).filter(Boolean))];
}

/** 全角字母数字转半角、英文转小写；逐字转换长度不变 */
function norm(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += c >= 0xff01 && c <= 0xff5e ? String.fromCharCode(c - 0xfee0) : ch;
  }
  return out.toLowerCase();
}
const DROP = /[\s\p{P}\p{S}]/u;

/** 比较用的紧凑文本：去掉空白和标点（识别结果的标点位置不可靠），每个字记下它属于第几句 */
function compact(segs: Segment[]): { s: string; seg: number[] } {
  let s = '';
  const seg: number[] = [];
  segs.forEach((g, i) => {
    for (const ch of norm(g.text)) {
      if (DROP.test(ch)) continue;
      s += ch;
      for (let k = 0; k < ch.length; k++) seg.push(i);
    }
  });
  return { s, seg };
}
const key = (w: string) => compact([{ start: 0, end: 0, text: w }]).s;

/** 在整段文字里找一组词的所有出现位置：不同词重叠时只算最长的那个；词可以跨两句 */
export function findHits(segs: Segment[], words: string[]): Hit[] {
  const { s, seg } = compact(segs);
  const found: { pos: number; len: number; word: string }[] = [];
  for (const w of words) {
    const k = key(w);
    if (!k) continue;
    for (let i = s.indexOf(k); i >= 0; i = s.indexOf(k, i + k.length)) found.push({ pos: i, len: k.length, word: w });
  }
  found.sort((a, b) => a.pos - b.pos || b.len - a.len);
  const out: Hit[] = [];
  let end = -1;
  for (const f of found) {
    if (f.pos < end) continue;
    end = f.pos + f.len;
    const g = segs[seg[f.pos]];
    out.push({ word: f.word, at: g.start, context: g.text.trim() });
  }
  return out;
}

export function evaluateRule(segs: Segment[], rule: Rule): RuleResult {
  const all = findHits(segs, rule.words);
  if (rule.kind === 'required') {
    const within = rule.withinSec && rule.withinSec > 0 ? rule.withinSec : 0;
    const hits = within ? all.filter((h) => h.at <= within) : all;
    const failed = hits.length === 0;
    const note = !failed ? '已说' : all.length ? `说了，但不在通话前 ${within} 秒内` : '漏说';
    return { rule, count: hits.length, hits, failed, deduct: failed ? rule.penalty : 0, note };
  }
  if (rule.kind === 'banned') {
    const failed = all.length > 0;
    return { rule, count: all.length, hits: all, failed, deduct: failed ? rule.penalty : 0, note: failed ? `命中 ${all.length} 次` : '未出现' };
  }
  const min = rule.min ?? 0;
  const max = rule.max ?? 0;
  const failed = (min > 0 && all.length < min) || (max > 0 && all.length > max);
  const need = [min > 0 ? `至少 ${min} 次` : '', max > 0 ? `最多 ${max} 次` : ''].filter(Boolean).join('、');
  const note = `出现 ${all.length} 次${need ? `（要求${need}${failed ? '，不符' : '，符合'}）` : ''}`;
  return { rule, count: all.length, hits: all, failed, deduct: failed ? rule.penalty : 0, note };
}

/** 满分 100，扣完为止；得分不低于 passScore 为合格 */
export function evaluate(segs: Segment[], config: Config): Report {
  const results = config.rules.filter((r) => r.words.some((w) => key(w))).map((r) => evaluateRule(segs, r));
  const score = Math.max(0, Math.min(100, 100 - results.reduce((n, r) => n + r.deduct, 0)));
  return { score, passed: score >= config.passScore, results };
}

/** 一句话概括问题，用在表格和 Excel 里；没有问题返回「无」 */
export function problems(report: Report): string {
  const list = report.results.filter((r) => r.failed).map((r) => {
    if (r.rule.kind === 'required') return `${r.note === '漏说' ? '漏说' : '未按时说'}「${r.rule.name}」`;
    if (r.rule.kind === 'banned') return `命中「${r.rule.name}」${r.count} 次（${[...new Set(r.hits.map((h) => h.word))].join('、')}）`;
    return `「${r.rule.name}」${r.note.replace(/^出现 /, '出现 ')}`;
  });
  return list.length ? list.join('；') : '无';
}

/** 每个关键词统计规则的出现次数，如「退款×3；投诉×1」 */
export function keywordSummary(report: Report): string {
  const list = report.results.filter((r) => r.rule.kind === 'keyword' && r.count > 0).map((r) => `${r.rule.name}×${r.count}`);
  return list.length ? list.join('；') : '无';
}

let seq = 0;
export const newId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;
