import { describe, expect, it } from 'vitest';
import { isSilent, planChunks, quietestPoint } from './chunks';
import { extractArgs, parseWav } from './audio';
import { cleanText, finalize, joinWordBreaks, offsetPieces, splitLong, textWidth } from './merge';
import { parseSrt, parseTime, shortTime, srtTime, toSrt, toTxt } from './srt';
import { transcribe } from './transcribe';
import { normalizePunct, polishChinese, toSimplified } from './chinese';
import { SAMPLE_RATE, type RawPiece } from './types';

const SR = SAMPLE_RATE;
const tone = (sec: number, amp = 0.3) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin(i / 20));

function wavBytes(samples: Int16Array, opt: { rate?: number; ch?: number; extra?: boolean; dataSize?: number } = {}) {
  const rate = opt.rate ?? SR;
  const ch = opt.ch ?? 1;
  const list = opt.extra ? new Uint8Array([...new TextEncoder().encode('LIST'), 5, 0, 0, 0, 1, 2, 3, 4, 5, 0]) : new Uint8Array();
  const dataLen = samples.length * 2;
  const buf = new Uint8Array(12 + 24 + list.length + 8 + dataLen);
  const dv = new DataView(buf.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, buf.length - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  buf.set(list, 36);
  const d = 36 + list.length;
  w(d, 'data'); dv.setUint32(d + 4, opt.dataSize ?? dataLen, true);
  samples.forEach((v, i) => dv.setInt16(d + 8 + i * 2, v, true));
  return buf;
}

describe('分段', () => {
  it('短音频只有一段', () => {
    expect(planChunks(tone(12))).toEqual([{ from: 0, to: 12 * SR }]);
  });
  it('刚好 30 秒不拆', () => {
    expect(planChunks(tone(30))).toHaveLength(1);
  });
  it('75 秒切成 3 段，首尾相接、每段不超过 30 秒、不遗漏', () => {
    const chunks = planChunks(tone(75));
    expect(chunks).toHaveLength(3);
    expect(chunks[0].from).toBe(0);
    expect(chunks.at(-1)!.to).toBe(75 * SR);
    chunks.forEach((c, i) => {
      expect(c.to - c.from).toBeLessThanOrEqual(30 * SR);
      if (i) expect(c.from).toBe(chunks[i - 1].to);
    });
  });
  it('切点落在最后 5 秒内最安静的地方', () => {
    const s = tone(70);
    // 在 27.0–27.3 秒制造一段静音
    s.fill(0, Math.round(27 * SR), Math.round(27.3 * SR));
    const first = planChunks(s)[0];
    expect(first.to / SR).toBeGreaterThan(27);
    expect(first.to / SR).toBeLessThan(27.3);
  });
  it('空音频没有分段；quietestPoint 在过短区间返回上界', () => {
    expect(planChunks(new Float32Array(0))).toEqual([]);
    expect(quietestPoint(new Float32Array(100), 0, 50)).toBe(50);
  });
  it('静音判断', () => {
    expect(isSilent(new Float32Array(SR))).toBe(true);
    expect(isSilent(tone(1))).toBe(false);
    expect(isSilent(new Float32Array(0))).toBe(true);
  });
});

describe('音频', () => {
  it('ffmpeg 参数：去视频、单声道、16k', () => {
    const a = extractArgs('/a/b.mp4', '/t/x.wav');
    expect(a).toContain('-vn');
    expect(a.join(' ')).toContain('-ac 1 -ar 16000');
    expect(a.at(-1)).toBe('/t/x.wav');
  });
  it('解析 WAV，含附加块', () => {
    const r = parseWav(wavBytes(Int16Array.from([0, 16384, -16384, 32767]), { extra: true }));
    expect(r.sampleRate).toBe(SR);
    expect(Array.from(r.samples).map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5, 1]);
  });
  it('data 长度写成 0（流式输出）时按文件实际长度读', () => {
    expect(parseWav(wavBytes(Int16Array.from([1, 2, 3]), { dataSize: 0 })).samples).toHaveLength(3);
  });
  it('格式不对 / 不是 WAV 时给出明确错误', () => {
    expect(() => parseWav(wavBytes(new Int16Array(4), { rate: 44100 }))).toThrow('16000Hz');
    expect(() => parseWav(wavBytes(new Int16Array(4), { ch: 2 }))).toThrow('单声道');
    expect(() => parseWav(new Uint8Array(100))).toThrow('不是有效的 WAV');
  });
});

describe('字幕格式', () => {
  it('时间格式', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(3723.4567)).toBe('01:02:03,457');
    expect(srtTime(-1)).toBe('00:00:00,000');
    expect(shortTime(62.5)).toBe('1:02.500');
    expect(shortTime(3723.4)).toBe('1:02:03.400');
  });
  it('解析界面输入的时间', () => {
    expect(parseTime('1.5')).toBe(1.5);
    expect(parseTime('1:02.5')).toBe(62.5);
    expect(parseTime('01:02:03,5')).toBe(3723.5);
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('1:2:3:4')).toBeNull();
    expect(parseTime('')).toBeNull();
  });
  it('生成 SRT 并能读回', () => {
    const segs = [{ start: 0, end: 2.5, text: '你好' }, { start: 2.5, end: 61.25, text: '第二行\n换行' }];
    const srt = toSrt(segs);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:02,500\n你好\n\n2\n00:00:02,500 --> 00:01:01,250\n第二行\n换行\n');
    expect(parseSrt(srt)).toEqual(segs);
  });
  it('纯文本一行一条，跳过空条', () => {
    expect(toTxt([{ start: 0, end: 1, text: ' 甲 ' }, { start: 1, end: 2, text: '' }, { start: 2, end: 3, text: '乙' }])).toBe('甲\n乙\n');
  });
  it('读 SRT 兼容 Windows 换行', () => {
    expect(parseSrt('1\r\n00:00:01,000 --> 00:00:02,000\r\n甲\r\n')).toEqual([{ start: 1, end: 2, text: '甲' }]);
  });
});

describe('时间戳合并与后处理', () => {
  it('窗口内时间平移到整段时间轴，缺失的结束时间用下一片段开头', () => {
    const p: RawPiece[] = [{ text: ' 甲', start: 0, end: null }, { text: ' 乙', start: 4, end: null }];
    expect(offsetPieces(p, 30, 60)).toEqual([{ start: 30, end: 34, text: '甲' }, { start: 34, end: 60, text: '乙' }]);
  });
  it('带结束时间的片段：开始和结束都要加上窗口起点', () => {
    expect(offsetPieces([{ text: '甲', start: 2, end: 6.5 }, { text: '乙', start: 6.5, end: 11 }], 30, 41.5)).toEqual([{ start: 32, end: 36.5, text: '甲' }, { start: 36.5, end: 41, text: '乙' }]);
  });
  it('字幕行尾的逗号去掉', () => {
    expect(finalize([{ start: 0, end: 3, text: '好的，' }])[0].text).toBe('好的');
  });
  it('超出窗口的时间被限制在窗口内；空文本丢弃', () => {
    const r = offsetPieces([{ text: '  ', start: 1, end: 2 }, { text: '甲', start: 20, end: 99 }], 0, 12);
    expect(r).toEqual([{ start: 12, end: 12, text: '甲' }]);
  });
  it('英文单词被切断时并回', () => {
    expect(joinWordBreaks([{ text: ' your ro', start: 0, end: 1 }, { text: 'om.', start: 1, end: 2 }])).toEqual([{ text: ' your room.', start: 0, end: 2 }]);
    expect(joinWordBreaks([{ text: ' a', start: 0, end: 1 }, { text: ' b', start: 1, end: 2 }])).toHaveLength(2);
  });
  it('文本清理：空格、重复', () => {
    expect(cleanText('  你 好   世界 ')).toBe('你好世界');
    expect(cleanText('hello  world')).toBe('hello world');
    expect(cleanText('哈哈哈哈哈哈哈哈哈哈')).toBe('哈哈哈');
    expect(cleanText('好的好的')).toBe('好的好的');
  });
  it('过长字幕按标点拆开，时间按字数比例分配、首尾相接', () => {
    const r = splitLong({ start: 10, end: 20, text: '今天我们来聊一聊如何整理房间，首先把不用的东西分类放好，然后每天花十分钟打扫桌面。' }, 16);
    expect(r.length).toBeGreaterThan(1);
    r.forEach((s) => expect(textWidth(s.text)).toBeLessThanOrEqual(16));
    expect(r[0].start).toBe(10);
    expect(r.at(-1)!.end).toBeCloseTo(20);
    r.forEach((s, i) => i && expect(s.start).toBeCloseTo(r[i - 1].end));
    expect(r.map((s) => s.text).join('')).toBe('今天我们来聊一聊如何整理房间，首先把不用的东西分类放好，然后每天花十分钟打扫桌面。');
  });
  it('没有标点的超长句硬切，英文不切断单词', () => {
    const en = splitLong({ start: 0, end: 6, text: 'Today we will talk about how to organize your room and many other things.' }, 12);
    expect(en.map((s) => s.text).join(' ').replace(/\s+/g, ' ')).toBe('Today we will talk about how to organize your room and many other things.');
    en.forEach((s) => expect(textWidth(s.text)).toBeLessThanOrEqual(12.5));
    const zh = splitLong({ start: 0, end: 3, text: '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸' }, 8);
    expect(zh.map((s) => s.text.length)).toEqual([7, 7, 6]);
  });
  it('收尾：排序、去连续重复幻觉、保证不重叠', () => {
    const r = finalize([
      { start: 5, end: 7, text: '乙' }, { start: 0, end: 3, text: '甲' },
      { start: 7, end: 8, text: '谢谢观看' }, { start: 8, end: 9, text: '谢谢观看' }, { start: 9, end: 10, text: '谢谢观看' },
      { start: 2, end: 2.1, text: '   ' },
    ]);
    expect(r.map((s) => s.text)).toEqual(['甲', '乙', '谢谢观看', '谢谢观看']);
    r.forEach((s, i) => { expect(s.end).toBeGreaterThan(s.start); if (i) expect(s.start).toBeGreaterThanOrEqual(r[i - 1].end - 1e-9); });
  });
  it('起止重叠时，前一条在后一条开始处结束', () => {
    const r = finalize([{ start: 0, end: 5, text: '甲' }, { start: 3, end: 8, text: '乙' }]);
    expect(r[0].end).toBe(3);
    expect(r[1].start).toBe(3);
  });
});

describe('中文后处理', () => {
  it('繁体转简体', () => {
    expect(toSimplified('歡迎收看今天的節目，軟件')).toBe('欢迎收看今天的节目，软件');
    expect(toSimplified('已经是简体')).toBe('已经是简体');
  });
  it('中文后的半角标点转全角，行尾逗号去掉', () => {
    expect(normalizePunct('大家好,欢迎收看今天的节目,')).toBe('大家好，欢迎收看今天的节目');
    expect(normalizePunct('真的吗?对!')).toBe('真的吗？对！');
  });
  it('数字小数点、英文句子不改', () => {
    expect(normalizePunct('版本3.5发布')).toBe('版本3.5发布');
    expect(normalizePunct('Hello, world.')).toBe('Hello, world.');
    expect(polishChinese('我們說: 好的.')).toBe('我们说：好的。');
  });
});

describe('转写流程（假识别器）', () => {
  it('75 秒音频：逐段调用、时间戳还原、静音段跳过、进度回报', async () => {
    const s = new Float32Array(75 * SR);
    s.set(tone(10), 0); // 0–10s 有声
    s.set(tone(10), 35 * SR); // 35–45s 有声；第 2 段前半
    const calls: number[] = [];
    const progress: [number, number][] = [];
    const segs = await transcribe(s, async (audio) => {
      calls.push(audio.length / SR);
      return [{ text: calls.length === 1 ? '第一句' : '第二句', start: calls.length === 1 ? 1 : 5, end: null }];
    }, { language: 'chinese', onProgress: (d, t) => progress.push([d, t]) });
    expect(calls).toHaveLength(2); // 第 3 段（60s 之后）全是静音，不调用识别器
    expect(segs[0]).toMatchObject({ text: '第一句', start: 1 });
    expect(segs[1].text).toBe('第二句');
    expect(segs[1].start).toBeGreaterThan(30); // 第二段从 ~30s 开始，加上窗口内 5s
    expect(progress[0]).toEqual([0, 3]);
    expect(progress.at(-1)).toEqual([3, 3]);
  });
  it('postText 作用在每条文字上；取消时抛错', async () => {
    const segs = await transcribe(tone(5), async () => [{ text: '歡迎', start: 0, end: 2 }], { language: 'chinese', postText: toSimplified });
    expect(segs[0].text).toBe('欢迎');
    const ac = new AbortController();
    ac.abort();
    await expect(transcribe(tone(5), async () => [], { language: 'chinese', signal: ac.signal })).rejects.toThrow('已取消');
  });
  it('语言参数原样传给识别器', async () => {
    let lang = '';
    await transcribe(tone(5), async (_a, o) => { lang = o.language; return []; }, { language: 'english' });
    expect(lang).toBe('english');
  });
});

import { checkSegments, mergeNext, removeAt, replaceAll, splitAt } from './edit';

describe('字幕编辑', () => {
  const base = [{ start: 0, end: 2, text: '你好' }, { start: 2, end: 5, text: '世界' }, { start: 5, end: 6, text: 'foo' }];
  it('删除和合并不改动原数组', () => {
    expect(removeAt(base, 1)).toHaveLength(2);
    expect(base).toHaveLength(3);
    expect(mergeNext(base, 0)).toEqual([{ start: 0, end: 5, text: '你好世界' }, base[2]]);
    expect(mergeNext(base, 2)).toBe(base);
  });
  it('英文合并补空格', () => {
    expect(mergeNext([{ start: 0, end: 1, text: 'Hello,' }, { start: 1, end: 2, text: 'world' }], 0)[0].text).toBe('Hello, world');
  });
  it('拆分：按字数比例分配时间；位置无效时不动', () => {
    const r = splitAt([{ start: 0, end: 10, text: '一二三四五六七八九十' }], 0, 4);
    expect(r).toEqual([{ start: 0, end: 4, text: '一二三四' }, { start: 4, end: 10, text: '五六七八九十' }]);
    expect(splitAt(base, 0, 0)).toBe(base);
    expect(splitAt(base, 0, 2)).toBe(base);
  });
  it('全文替换：按字面、统计处数，空查找不动', () => {
    const r = replaceAll([{ start: 0, end: 1, text: '安装包和安装包' }, { start: 1, end: 2, text: '无关' }], '安装包', '安装程序');
    expect(r.count).toBe(2);
    expect(r.segs[0].text).toBe('安装程序和安装程序');
    expect(replaceAll(base, '', 'x').count).toBe(0);
    expect(replaceAll(base, '.*', 'x').count).toBe(0);
  });
  it('检查问题', () => {
    expect(checkSegments(base)).toEqual([]);
    const bad = [{ start: 0, end: 3, text: 'a' }, { start: 2, end: 2, text: ' ' }];
    expect(checkSegments(bad).map((x) => x.kind).sort()).toEqual(['empty', 'order', 'overlap']);
  });
});
