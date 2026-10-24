// 质检结果导出 Excel（exceljs，MIT）：汇总 / 命中明细 / 转写文字 / 质检规则四个工作表。
import ExcelJS from 'exceljs';
import type { Segment } from './asr';
import { KIND_NAME, keywordSummary, problems, type Config, type Report } from './core';

export interface Row { name: string; duration: number; segs: Segment[]; report: Report }

type Cell = string | number | null;
/** 以 = + - @ 开头的文字会被 Excel 当成公式，前面补一个单引号式的空格前缀避免执行 */
const safe = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const wid = (v: Cell) => (v == null ? 0 : [...String(v)].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0));

export function buildSheets(rows: Row[], config: Config): { name: string; header: string[]; rows: Cell[][] }[] {
  const rules = config.rules.filter((r) => rows.some((x) => x.report.results.some((q) => q.rule.id === r.id)));
  const summary = {
    name: '汇总',
    header: ['序号', '录音文件', '时长', '得分', '结论', '问题', '关键词统计', ...rules.map((r) => `${r.name}（${r.kind === 'required' ? '说了几次' : '命中次数'}）`)],
    rows: rows.map((x, i): Cell[] => [
      i + 1, safe(x.name), mmss(x.duration), x.report.score, x.report.passed ? '合格' : '不合格', safe(problems(x.report)), safe(keywordSummary(x.report)),
      ...rules.map((r) => x.report.results.find((q) => q.rule.id === r.id)?.count ?? 0),
    ]),
  };
  const detail = {
    name: '命中明细',
    header: ['录音文件', '规则类型', '规则', '命中词', '时间', '所在句子'],
    rows: rows.flatMap((x) => x.report.results.flatMap((q) => [
      ...q.hits.map((h): Cell[] => [safe(x.name), KIND_NAME[q.rule.kind], safe(q.rule.name), safe(h.word), mmss(h.at), safe(h.context)]),
      ...(q.rule.kind === 'required' && q.failed ? [[safe(x.name), KIND_NAME.required, safe(q.rule.name), '（未命中）', '', safe(q.note)] as Cell[]] : []),
    ])),
  };
  const text = { name: '转写文字', header: ['录音文件', '时间', '文字'], rows: rows.flatMap((x) => x.segs.map((s): Cell[] => [safe(x.name), mmss(s.start), safe(s.text)])) };
  const ruleSheet = {
    name: '质检规则',
    header: ['类型', '规则名', '词 / 同义词', '不达标扣分', '补充条件'],
    rows: [
      ...config.rules.map((r): Cell[] => [KIND_NAME[r.kind], safe(r.name), safe(r.words.join('、')), r.penalty,
        r.kind === 'required' ? (r.withinSec ? `通话前 ${r.withinSec} 秒内` : '不限时间') : r.kind === 'keyword' ? [r.min ? `至少 ${r.min} 次` : '', r.max ? `最多 ${r.max} 次` : ''].filter(Boolean).join('、') || '只统计次数' : '命中即扣一次']),
      ['', '', '', '', ''],
      ['说明', `满分 100，扣完为止；${config.passScore} 分及以上为合格。转写由本机离线识别，可能有错字，请抽查。`, '', '', ''],
    ],
  };
  return [summary, detail, text, ruleSheet];
}

export async function writeReport(rows: Row[], config: Config): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '篝火 · 电话录音质检';
  for (const s of buildSheets(rows, config)) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(s.header).font = { bold: true };
    for (const r of s.rows) ws.addRow(r);
    ws.columns.forEach((col, ci) => {
      const w = Math.max(wid(s.header[ci]), ...s.rows.slice(0, 500).map((r) => wid(r[ci] ?? null)));
      col.width = Math.min(70, Math.max(8, w + 2));
    });
    if (s.name === '汇总') {
      const failCol = 5;
      ws.eachRow((row, n) => { if (n > 1 && row.getCell(failCol).value === '不合格') row.getCell(failCol).font = { color: { argb: 'FFC62828' }, bold: true }; });
    }
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
