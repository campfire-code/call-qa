// 中文文本后处理：繁体转简体、标点规范化。Whisper 识别中文时常输出繁体和半角标点。
import { Converter } from 'opencc-js/t2cn';

let conv: ((s: string) => string) | null = null;

/** 繁体转简体（逐字 + 词组，OpenCC 字典）；已是简体的文字不受影响 */
export function toSimplified(text: string): string {
  conv ??= Converter({ from: 't', to: 'cn' });
  return conv(text);
}

const CJK = /[㐀-鿿]/;
const FULL: Record<string, string> = { ',': '，', '?': '？', '!': '！', ';': '；', ':': '：', '.': '。' };

/** 紧跟在中文后面的半角标点改成全角，并去掉行尾多余的逗号 / 顿号；英文句子不动 */
export function normalizePunct(text: string): string {
  let out = '';
  let prevCjk = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const isPunct = c in FULL;
    // 小数点、时间、网址里的点和冒号（前后都是数字或字母）不改
    const betweenWord = isPunct && /[\w]/.test(text[i + 1] ?? '') && /[\w]/.test(text[i - 1] ?? '');
    if (isPunct && prevCjk && !betweenWord) {
      out += FULL[c];
      while (text[i + 1] === ' ') i++; // 中文标点后不留空格
      continue;
    }
    out += c;
    if (c !== ' ') prevCjk = CJK.test(c);
  }
  return out.replace(/[，、,]+\s*$/u, '');
}

/** 中文后处理合集：简体 + 标点 */
export const polishChinese = (text: string) => normalizePunct(toSimplified(text));
