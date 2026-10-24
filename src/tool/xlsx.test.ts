import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { evaluate } from './core';
import { DEFAULT_CONFIG, DEMO } from './samples';
import { buildSheets, writeReport } from './xlsx';

const rows = DEMO.map((d) => ({ name: d.name, duration: d.duration, segs: d.segs, report: evaluate(d.segs, DEFAULT_CONFIG) }));

async function read(bytes: Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return wb;
}

describe('Excel 导出', () => {
  it('四个工作表，汇总里每通录音一行，得分、结论、问题正确', async () => {
    const wb = await read(await writeReport(rows, DEFAULT_CONFIG));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['汇总', '命中明细', '转写文字', '质检规则']);
    const ws = wb.getWorksheet('汇总')!;
    expect(ws.rowCount).toBe(4);
    expect((ws.getRow(1).values as unknown[]).slice(1, 8)).toEqual(['序号', '录音文件', '时长', '得分', '结论', '问题', '关键词统计']);
    expect(ws.getRow(2).getCell(2).value).toBe('示例通话A-合格.mp3');
    expect(ws.getRow(2).getCell(4).value).toBe(100);
    expect(ws.getRow(2).getCell(5).value).toBe('合格');
    expect(ws.getRow(3).getCell(4).value).toBe(0);
    expect(ws.getRow(3).getCell(5).value).toBe('不合格');
    expect(String(ws.getRow(4).getCell(6).value)).toContain('漏说「报身份（示例）」');
    expect(ws.getRow(4).getCell(7).value).toBe('退款（示例）×3');
  });
  it('汇总里每条规则一列，列出命中次数', () => {
    const [sum] = buildSheets(rows, DEFAULT_CONFIG);
    expect(sum.header.slice(7)).toHaveLength(DEFAULT_CONFIG.rules.length);
    const col = sum.header.findIndex((h) => h.startsWith('退款（示例）'));
    expect(sum.rows.map((r) => r[col])).toEqual([0, 1, 3]);
  });
  it('命中明细：违禁词逐处列出，漏说的必说项也有一行', () => {
    const [, d] = buildSheets(rows, DEFAULT_CONFIG);
    const b = d.rows.filter((r) => r[0] === '示例通话B-违规.m4a');
    expect(b.some((r) => r[1] === '违禁 / 敏感词' && r[3] === '绝对' && r[4] === '00:02')).toBe(true);
    expect(b.some((r) => r[2] === '开场问候（示例）' && r[3] === '（未命中）' && r[5] === '漏说')).toBe(true);
  });
  it('转写文字和规则快照都在', async () => {
    const wb = await read(await writeReport(rows, DEFAULT_CONFIG));
    expect(wb.getWorksheet('转写文字')!.rowCount).toBe(1 + rows.reduce((n, r) => n + r.segs.length, 0));
    expect(wb.getWorksheet('质检规则')!.rowCount).toBe(1 + DEFAULT_CONFIG.rules.length + 2);
  });
  it('以 = 开头的文字不会被当成公式', () => {
    const evil = [{ name: '=HYPERLINK("x").mp3', duration: 1, segs: [{ start: 0, end: 1, text: '=1+1' }], report: evaluate([{ start: 0, end: 1, text: '=1+1' }], DEFAULT_CONFIG) }];
    const [sum, , text] = buildSheets(evil, DEFAULT_CONFIG);
    expect(String(sum.rows[0][1]).startsWith("'=")).toBe(true);
    expect(String(text.rows[0][2]).startsWith("'=")).toBe(true);
  });
});
