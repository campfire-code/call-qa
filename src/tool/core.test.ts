import { describe, expect, it } from 'vitest';
import type { Segment } from './asr';
import { evaluate, evaluateRule, findHits, keywordSummary, parseWords, problems, type Config, type Rule } from './core';
import { DEFAULT_CONFIG, DEMO } from './samples';

const S = (text: string, start = 0): Segment => ({ start, end: start + 3, text });

describe('parseWords', () => {
  it('按逗号、顿号、分号、竖线、换行拆分，去空去重', () => {
    expect(parseWords('您好, 你好、早上好；您好\n|晚上好 ,')).toEqual(['您好', '你好', '早上好', '晚上好']);
    expect(parseWords('  ')).toEqual([]);
  });
});

describe('findHits', () => {
  it('忽略标点、空格、大小写和全角', () => {
    const hits = findHits([S('请问有任何问题，随时联系 ＶＩＰ 客服。')], ['vip客服', '随时 联系']);
    expect(hits.map((h) => h.word).sort()).toEqual(['vip客服', '随时 联系'].sort());
  });
  it('词可以跨两句话，时间取开头那句', () => {
    const hits = findHits([S('这件事我保', 10), S('证没问题', 14)], ['保证']);
    expect(hits).toEqual([{ word: '保证', at: 10, context: '这件事我保' }]);
  });
  it('不同词重叠时只算最长的，同一个词不重叠地数多次', () => {
    const segs = [S('保证收益，保证收益，我保证。')];
    const hits = findHits(segs, ['保证', '保证收益']);
    expect(hits.map((h) => h.word)).toEqual(['保证收益', '保证收益', '保证']);
    expect(findHits([S('哈哈哈哈')], ['哈哈'])).toHaveLength(2);
  });
  it('空词和只有标点的词被忽略，不会命中一切', () => {
    expect(findHits([S('你好')], ['', '，，', '  '])).toEqual([]);
  });
});

const req = (o: Partial<Rule> = {}): Rule => ({ id: 'a', kind: 'required', name: '问候', words: ['您好', '你好'], penalty: 15, withinSec: 0, ...o });

describe('必说话术', () => {
  it('说到了不扣分', () => {
    const r = evaluateRule([S('您好，请讲')], req());
    expect(r).toMatchObject({ failed: false, deduct: 0, count: 1, note: '已说' });
  });
  it('漏说扣分', () => {
    const r = evaluateRule([S('喂，请讲')], req());
    expect(r).toMatchObject({ failed: true, deduct: 15, note: '漏说' });
  });
  it('限定前 N 秒：窗口外才说的算没按时说', () => {
    const segs = [S('请讲', 0), S('您好', 40)];
    expect(evaluateRule(segs, req({ withinSec: 30 }))).toMatchObject({ failed: true, deduct: 15, note: '说了，但不在通话前 30 秒内' });
    expect(evaluateRule(segs, req({ withinSec: 45 })).failed).toBe(false);
  });
});

describe('违禁词与关键词', () => {
  const ban: Rule = { id: 'b', kind: 'banned', name: '承诺', words: ['保证', '绝对'], penalty: 30 };
  it('命中多次只扣一次，明细列出每一处和时间', () => {
    const r = evaluateRule([S('我保证', 5), S('绝对可以，保证', 20)], ban);
    expect(r).toMatchObject({ failed: true, count: 3, deduct: 30 });
    expect(r.hits.map((h) => h.at)).toEqual([5, 20, 20]);
  });
  it('没命中不扣分', () => {
    expect(evaluateRule([S('您好')], ban)).toMatchObject({ failed: false, deduct: 0, count: 0, note: '未出现' });
  });
  const kw = (o: Partial<Rule>): Rule => ({ id: 'k', kind: 'keyword', name: '退款', words: ['退款'], penalty: 10, min: 0, max: 0, ...o });
  const segs = [S('退款需要审核，退款三天到账')];
  it('只统计：不扣分', () => {
    expect(evaluateRule(segs, kw({}))).toMatchObject({ count: 2, failed: false, deduct: 0, note: '出现 2 次' });
  });
  it('至少 / 最多不符时扣分', () => {
    expect(evaluateRule(segs, kw({ min: 3 }))).toMatchObject({ failed: true, deduct: 10 });
    expect(evaluateRule(segs, kw({ max: 1 }))).toMatchObject({ failed: true, deduct: 10 });
    expect(evaluateRule(segs, kw({ min: 2, max: 2 }))).toMatchObject({ failed: false, deduct: 0 });
  });
});

describe('evaluate 计分', () => {
  const cfg: Config = { passScore: 80, rules: [req(), { id: 'b', kind: 'banned', name: '承诺', words: ['保证'], penalty: 30 }, { id: 'e', kind: 'required', name: '空规则', words: [''], penalty: 50 }] };
  it('满分 100 扣完为止；词为空的规则不参与', () => {
    expect(evaluate([S('您好')], cfg)).toMatchObject({ score: 100, passed: true });
    expect(evaluate([S('喂')], cfg).score).toBe(85);
    expect(evaluate([S('喂我保证')], cfg)).toMatchObject({ score: 55, passed: false });
    expect(evaluate([S('喂我保证')], cfg).results).toHaveLength(2);
  });
  it('不会扣成负数', () => {
    const big: Config = { passScore: 60, rules: [req({ penalty: 80 }), { id: 'b', kind: 'banned', name: 'x', words: ['保证'], penalty: 80 }] };
    expect(evaluate([S('喂我保证')], big).score).toBe(0);
  });
  it('得分刚好等于及格分算合格', () => {
    expect(evaluate([S('喂')], { ...cfg, passScore: 85 }).passed).toBe(true);
    expect(evaluate([S('喂')], { ...cfg, passScore: 86 }).passed).toBe(false);
  });
});

describe('示例规则 × 示例录音的识别结果', () => {
  const [a, b, c] = DEMO.map((d) => evaluate(d.segs, DEFAULT_CONFIG));
  it('A 合格：「势力」「公号」这类同音字误识别不影响，因为同义词里加了「客服中心」「公号」', () => {
    expect(a.score).toBe(100);
    expect(a.passed).toBe(true);
    expect(problems(a)).toBe('无');
  });
  it('B 违规：漏问候、漏报身份、漏结束语，且命中两组违禁词 → 0 分', () => {
    expect(b.score).toBe(0);
    expect(b.passed).toBe(false);
    expect(problems(b)).toContain('漏说「开场问候（示例）」');
    expect(problems(b)).toContain('命中「绝对化承诺（示例）」2 次（绝对、保证）');
    expect(problems(b)).toContain('命中「不当用语（示例）」2 次（别投诉、先挂了）');
  });
  it('C 漏说：漏报身份和结束语，退款提到 3 次 → 75 分不合格', () => {
    expect(c.score).toBe(75);
    expect(c.passed).toBe(false);
    expect(keywordSummary(c)).toBe('退款（示例）×3');
  });
});

describe('README 里的改规则用例', () => {
  const rule = (c: Config, id: string, p: Partial<Rule>): Config => ({ ...c, rules: c.rules.map((r) => (r.id === id ? { ...r, ...p } : r)) });
  it('C 的「报身份」加上同义词后 90 分，只剩漏说结束语', () => {
    const cfg = rule(DEFAULT_CONFIG, 'd2', { words: [...DEFAULT_CONFIG.rules[1].words, '请问有什么可以帮您'] });
    const r = evaluate(DEMO[2].segs, cfg);
    expect(r.score).toBe(90);
    expect(problems(r)).toBe('漏说「结束语（示例）」');
  });
  it('A 的「结束语」限前 10 秒后 90 分、合格', () => {
    const r = evaluate(DEMO[0].segs, rule(DEFAULT_CONFIG, 'd3', { withinSec: 10 }));
    expect(r).toMatchObject({ score: 90, passed: true });
    expect(problems(r)).toBe('未按时说「结束语（示例）」');
  });
});
