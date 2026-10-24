// 质检规则保存在本机设置里。
import { settingsStore } from '../kit/platform';
import type { Config, Rule } from './core';
import { DEFAULT_CONFIG } from './samples';

const KEY = 'rules';

function clean(v: unknown): Config {
  const c = v as Partial<Config> | undefined;
  if (!c || !Array.isArray(c.rules)) return DEFAULT_CONFIG;
  const rules = c.rules.filter((r): r is Rule => !!r && typeof r.id === 'string' && ['required', 'banned', 'keyword'].includes(r.kind) && Array.isArray(r.words));
  return { rules, passScore: typeof c.passScore === 'number' ? c.passScore : DEFAULT_CONFIG.passScore };
}

export async function loadConfig(): Promise<Config> {
  try {
    return clean(await (await settingsStore()).get(KEY));
  } catch {
    return DEFAULT_CONFIG;
  }
}
export async function saveConfig(c: Config) {
  try {
    await (await settingsStore()).set(KEY, c);
  } catch { /* 存不下不影响使用 */ }
}
export { clean as cleanConfig };
