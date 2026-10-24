// 主界面：导入录音 → 本机转写 → 按规则质检 → 看明细 → 导出 Excel。规则可随时修改，结果立即重算，不用重新转写。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { ChevronDown, ChevronRight, FileAudio, FolderOpen, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { ProgressBar, useDroppedFiles } from '../kit/parts';
import { pickFiles, pickFolder, reveal, settingsStore } from '../kit/platform';
import { MODELS, type Segment } from './asr';
import { KIND_NAME, evaluate, newId, parseWords, problems, type Config, type Kind, type Report, type Rule } from './core';
import { AUDIO_EXTENSIONS, runJob, type Stage } from './engine';
import { DEFAULT_CONFIG, DEMO } from './samples';
import { loadConfig, saveConfig } from './store';
import { writeReport } from './xlsx';
import './tool.css';

type Ctx = Parameters<CustomTool['Main']>[0]['ctx'];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const isPreview = typeof location !== 'undefined' && location.pathname.endsWith('preview.html');
const SPAN: Record<Stage['step'], [number, number]> = { extract: [0, 0.1], download: [0.1, 0.2], load: [0.2, 0.2], recognize: [0.2, 1] };

interface Item {
  id: string;
  path: string;
  name: string;
  status: 'wait' | 'run' | 'ok' | 'err';
  ratio: number;
  text: string;
  segs?: Segment[];
  duration?: number;
  error?: string;
}
interface Prefs { model: string; localDir: string }
const DEFAULT_PREFS: Prefs = { model: 'small', localDir: '' };

const demoItems = (): Item[] => DEMO.map((d, i) => ({ id: `d${i}`, path: `/示例/${d.name}`, name: d.name, status: 'ok', ratio: 1, text: '', segs: d.segs, duration: d.duration }));

export function Main({ ctx }: { ctx?: Ctx }) {
  const [items, setItems] = useState<Item[]>(isPreview ? demoItems() : []);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [tab, setTab] = useState<'result' | 'rules'>(isPreview && new URLSearchParams(location.search).get('tab') === 'rules' ? 'rules' : 'result');
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const ref = useRef(items);
  ref.current = items;

  useEffect(() => {
    if (isPreview) return;
    void loadConfig().then(setConfig);
    void settingsStore().then((s) => s.get<Partial<Prefs>>('prefs')).then((v) => setPrefs((p) => ({ ...p, ...v }))).catch(() => {});
  }, []);
  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setPrefs((p) => { const n = { ...p, [k]: v }; void settingsStore().then((s) => s.set('prefs', n)).catch(() => {}); return n; });
  const updateConfig = (fn: (c: Config) => Config) => setConfig((c) => { const n = fn(c); void saveConfig(n); return n; });

  const add = useCallback((paths: string[]) => {
    const ok = paths.filter((p) => AUDIO_EXTENSIONS.includes((p.split('.').pop() ?? '').toLowerCase()));
    const known = new Set(ref.current.map((i) => i.path));
    const fresh = ok.filter((p) => !known.has(p));
    if (!ok.length) setMsg({ kind: 'err', text: `没有可处理的录音，支持：${AUDIO_EXTENSIONS.join('、')}` });
    else setMsg(paths.length > ok.length ? { kind: 'err', text: `已添加 ${fresh.length} 个，另有 ${paths.length - ok.length} 个不是支持的录音格式，已跳过` } : null);
    setItems((cur) => [...cur, ...fresh.map((path): Item => ({ id: `${Date.now()}_${path}`, path, name: baseName(path), status: 'wait', ratio: 0, text: '' }))]);
  }, []);
  const hover = useDroppedFiles((paths) => !running && add(paths));

  const patch = (id: string, p: Partial<Item>) => setItems((cur) => cur.map((i) => (i.id === id ? { ...i, ...p } : i)));

  async function start() {
    if (!ctx || running) return;
    const queue = ref.current.filter((i) => i.status === 'wait' || i.status === 'err');
    if (!queue.length) return setMsg({ kind: 'err', text: '先添加录音，或点「重试失败的」' });
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true); setMsg(null);
    let ok = 0, failed = 0;
    for (const it of queue) {
      if (ac.signal.aborted) break;
      patch(it.id, { status: 'run', ratio: 0, error: undefined, text: '准备中…' });
      try {
        const r = await runJob(ctx, { path: it.path, model: prefs.model, language: 'chinese', simplified: true, maxWidth: 24, localDir: prefs.localDir }, (s) => { const [a, b] = SPAN[s.step]; patch(it.id, { ratio: a + (b - a) * s.ratio, text: s.text }); }, ac.signal);
        patch(it.id, { status: 'ok', ratio: 1, segs: r.segments, duration: r.duration, text: '' });
        ok++;
      } catch (e) {
        if (ac.signal.aborted) patch(it.id, { status: 'wait', ratio: 0, text: '' });
        else { patch(it.id, { status: 'err', error: errText(e), text: '' }); failed++; }
      }
    }
    setRunning(false); abort.current = null;
    setMsg(ac.signal.aborted ? { kind: 'err', text: '已暂停，未处理的录音保持等待' } : { kind: failed ? 'err' : 'ok', text: failed ? `转写完成 ${ok} 个，失败 ${failed} 个，原因见列表` : `全部转写完成，共 ${ok} 个。可以在「质检规则」里调整规则，结果会立即更新` });
  }

  const reports = useMemo(() => new Map(items.filter((i) => i.segs).map((i) => [i.id, evaluate(i.segs!, config)] as [string, Report])), [items, config]);
  const done = items.filter((i) => i.segs);
  const stat = useMemo(() => {
    const rs = done.map((i) => reports.get(i.id)!);
    return { total: rs.length, pass: rs.filter((r) => r.passed).length, avg: rs.length ? Math.round(rs.reduce((n, r) => n + r.score, 0) / rs.length) : 0 };
  }, [done, reports]);

  async function exportXlsx() {
    if (!ctx || !done.length) return;
    try {
      const path = await save({ defaultPath: `电话录音质检-${new Date().toISOString().slice(0, 10)}.xlsx`, filters: [{ name: 'Excel 表格', extensions: ['xlsx'] }] });
      if (!path) return;
      await ctx.writeFile(path, await writeReport(done.map((i) => ({ name: i.name, duration: i.duration ?? 0, segs: i.segs!, report: reports.get(i.id)! })), config));
      setMsg({ kind: 'ok', text: `已导出 ${baseName(path)}（含汇总、命中明细、转写文字、质检规则四个工作表）` });
      void reveal(path).catch(() => {});
    } catch (e) {
      setMsg({ kind: 'err', text: `导出失败：${errText(e)}` });
    }
  }

  const waiting = items.filter((i) => i.status === 'wait' || i.status === 'err').length;
  return (
    <div className="cq-root">
      <section className="k-panel cq-top">
        <div className="cq-file">
          <span className={`cq-drop${hover ? ' hover' : ''}${items.length ? ' has' : ''}`}>
            <FileAudio size={22} aria-hidden />
            <span className="cq-file-text">
              <b>{items.length ? `已添加 ${items.length} 通录音` : '把通话录音拖到这里'}</b>
              <span className="k-muted">{items.length ? '可继续拖入更多' : 'mp3、m4a、wav、amr、aac、flac 等，文件不会上传'}</span>
            </span>
          </span>
          <button className="k-btn" disabled={running} onClick={async () => add(await pickFiles(AUDIO_EXTENSIONS, '录音'))}>添加录音…</button>
          <button className="k-btn" disabled={running || !items.length} onClick={() => { setItems([]); setMsg(null); }}>清空</button>
          {running ? <button className="k-btn" onClick={() => abort.current?.abort()}>暂停</button> : <button className="k-btn primary" disabled={!ctx || !waiting} onClick={start}>{items.some((i) => i.status === 'err') && !items.some((i) => i.status === 'wait') ? '重试失败的' : '开始转写并质检'}</button>}
        </div>
        <div className="cq-opts">
          <label className="cq-opt"><span className="k-label">识别模型（中文）</span>
            <select className="k-input" value={prefs.model} disabled={running} onChange={(e) => setPref('model', e.target.value)}>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
          </label>
          <span className="k-muted cq-model">{prefs.localDir ? <>本地模型文件夹：<span title={prefs.localDir}>{baseName(prefs.localDir)}</span></> : '模型首次使用自动下载，之后离线可用。'}</span>
          <button className="k-btn cq-sm" disabled={running} onClick={async () => { const d = await pickFolder(); if (d) setPref('localDir', d); }}><FolderOpen size={14} aria-hidden />指定本地模型文件夹…</button>
          {prefs.localDir && <button className="k-btn cq-sm" disabled={running} onClick={() => setPref('localDir', '')}>改回自动下载</button>}
        </div>
        {msg && <div className={`cq-msg ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</div>}
      </section>

      <div className="cq-tabs" role="tablist" aria-label="功能">
        <button role="tab" aria-selected={tab === 'result'} className={`k-chip${tab === 'result' ? ' on' : ''}`} onClick={() => setTab('result')}>质检结果</button>
        <button role="tab" aria-selected={tab === 'rules'} className={`k-chip${tab === 'rules' ? ' on' : ''}`} onClick={() => setTab('rules')}>质检规则（{config.rules.length}）</button>
        <span className="cq-sp" />
        {tab === 'result' && done.length > 0 && <>
          <span className="k-muted k-num">已质检 {stat.total} 通 · 合格 {stat.pass} · 不合格 {stat.total - stat.pass} · 平均 {stat.avg} 分</span>
          <button className="k-btn primary" onClick={exportXlsx}>导出 Excel 汇总</button>
        </>}
      </div>

      {tab === 'result' ? <Results items={items} reports={reports} config={config} remove={(id) => setItems((c) => c.filter((i) => i.id !== id))} running={running} /> : <Rules config={config} update={updateConfig} />}
    </div>
  );
}

function Results({ items, reports, config, remove, running }: { items: Item[]; reports: Map<string, Report>; config: Config; remove: (id: string) => void; running: boolean }) {
  const [open, setOpen] = useState<string | null>(isPreview ? 'd1' : null);
  if (!items.length) return <div className="cq-empty k-muted">添加录音后点「开始转写并质检」。转写和质检都在本机完成，不联网（仅首次需要下载识别模型），不需要显卡。<br />不区分坐席和客户：整通录音按一份文字稿检查。</div>;
  return (
    <section className="k-panel cq-results">
      <table className="cq-table">
        <thead><tr><th aria-label="展开" /><th>录音</th><th className="r">时长</th><th className="r">得分</th><th>结论</th><th>问题</th><th aria-label="操作" /></tr></thead>
        <tbody>
          {items.map((it) => {
            const r = reports.get(it.id);
            const isOpen = open === it.id && !!r;
            return (
              <Fragment key={it.id}>
                <tr className={`cq-row${r && !r.passed ? ' bad' : ''}`}>
                  <td>{r && <button className="k-icon-btn" aria-label={isOpen ? '收起明细' : '展开明细'} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : it.id)}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}</td>
                  <td className="cq-name"><span className="k-ellipsis" title={it.path}>{it.name}</span></td>
                  <td className="r k-num">{it.duration ? mmss(it.duration) : '—'}</td>
                  {r ? <>
                    <td className="r k-num cq-score">{r.score}</td>
                    <td><span className={`cq-tag ${r.passed ? 'ok' : 'err'}`}>{r.passed ? '合格' : '不合格'}</span></td>
                    <td className="cq-prob">{problems(r)}</td>
                  </> : <td colSpan={3}>
                    {it.status === 'run' ? <div className="cq-prog"><ProgressBar ratio={it.ratio} label={it.text} /><span className="k-muted">{it.text}</span></div>
                      : it.status === 'err' ? <span className="cq-err">{it.error}</span> : <span className="k-muted">等待转写</span>}
                  </td>}
                  <td><button className="k-icon-btn" aria-label={`移除 ${it.name}`} disabled={running && it.status === 'run'} onClick={() => remove(it.id)}><Trash2 size={14} /></button></td>
                </tr>
                {isOpen && r && <tr className="cq-detail"><td /><td colSpan={6}><Detail item={it} report={r} passScore={config.passScore} /></td></tr>}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Detail({ item, report, passScore }: { item: Item; report: Report; passScore: number }) {
  const hitTimes = new Set(report.results.flatMap((r) => r.hits.filter(() => r.rule.kind === 'banned').map((h) => h.at)));
  return (
    <div className="cq-detail-in">
      <div className="cq-sub k-muted">满分 100，{passScore} 分及以上合格；下面是每条规则的检查情况。</div>
      <ul className="cq-rules">
        {report.results.map((r) => (
          <li key={r.rule.id} className={r.failed ? 'bad' : ''}>
            <span className={`cq-kind ${r.rule.kind}`}>{KIND_NAME[r.rule.kind]}</span>
            <b>{r.rule.name}</b>
            <span className={r.failed ? 'cq-err' : 'k-muted'}>{r.note}{r.deduct ? `，扣 ${r.deduct} 分` : ''}</span>
            {r.hits.length > 0 && <span className="cq-hits">{r.hits.slice(0, 6).map((h, i) => <span key={i} className="cq-hit" title={h.context}><span className="k-num">{mmss(h.at)}</span> {h.word}</span>)}{r.hits.length > 6 && <span className="k-muted"> 等 {r.hits.length} 处</span>}</span>}
          </li>
        ))}
      </ul>
      <div className="cq-sub"><b>转写文字</b> <span className="k-muted">（红底为命中违禁词的那句话；识别可能有错字，请抽查）</span></div>
      <ol className="cq-trans">
        {item.segs!.map((s, i) => <li key={i} className={hitTimes.has(s.start) ? 'bad' : ''}><span className="k-num k-muted">{mmss(s.start)}</span> {s.text}</li>)}
      </ol>
    </div>
  );
}

const BLANK: Record<Kind, Omit<Rule, 'id'>> = {
  required: { kind: 'required', name: '新话术', words: [], penalty: 10, withinSec: 0 },
  banned: { kind: 'banned', name: '新违禁词组', words: [], penalty: 20 },
  keyword: { kind: 'keyword', name: '新关键词', words: [], penalty: 0, min: 0, max: 0 },
};
const HELP: Record<Kind, string> = {
  required: '这些话必须说到：词组里的任意一个出现就算说了；没说到按「漏说扣分」扣。可限定只认通话开头 N 秒内。',
  banned: '这些词不能出现：命中任意一个就按「扣分」扣一次（命中几次都只扣一次），明细里列出每一处。',
  keyword: '统计这些词一共出现几次。默认只统计、不扣分；填了「至少 / 最多」且次数不符时才按「扣分」扣。',
};

function Rules({ config, update }: { config: Config; update: (fn: (c: Config) => Config) => void }) {
  const setRule = (id: string, p: Partial<Rule>) => update((c) => ({ ...c, rules: c.rules.map((r) => (r.id === id ? { ...r, ...p } : r)) }));
  return (
    <section className="k-panel cq-rulepage">
      <div className="cq-passrow">
        <label className="k-label" htmlFor="cq-pass">及格分</label>
        <input id="cq-pass" type="number" className="k-input cq-num" min={0} max={100} value={config.passScore} onChange={(e) => update((c) => ({ ...c, passScore: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))} />
        <span className="k-muted">满分 100，每条不达标的规则扣对应分数，扣完为止。</span>
        <span className="cq-sp" />
        <button className="k-btn cq-sm" onClick={() => window.confirm('恢复成内置的示例规则？你现在的规则会被替换。') && update(() => DEFAULT_CONFIG)}><RotateCcw size={14} aria-hidden />恢复示例规则</button>
      </div>
      {(['required', 'banned', 'keyword'] as Kind[]).map((kind) => (
        <div key={kind} className="cq-group">
          <div className="cq-ghead"><b>{KIND_NAME[kind]}</b><span className="k-muted">{HELP[kind]}</span>
            <button className="k-btn cq-sm" onClick={() => update((c) => ({ ...c, rules: [...c.rules, { id: newId(), ...BLANK[kind] }] }))}><Plus size={14} aria-hidden />添加</button>
          </div>
          {config.rules.filter((r) => r.kind === kind).map((r) => (
            <div key={r.id} className="cq-rule">
              <input className="k-input cq-rname" aria-label="规则名" value={r.name} onChange={(e) => setRule(r.id, { name: e.target.value })} />
              <WordsInput value={r.words} onCommit={(w) => setRule(r.id, { words: w })} />
              <label className="cq-field"><span className="k-muted">{kind === 'required' ? '漏说扣' : '扣'}</span><input type="number" className="k-input cq-num" min={0} max={100} aria-label="扣分" value={r.penalty} onChange={(e) => setRule(r.id, { penalty: Math.max(0, Number(e.target.value) || 0) })} /><span className="k-muted">分</span></label>
              {kind === 'required' && <label className="cq-field"><span className="k-muted">限前</span><input type="number" className="k-input cq-num" min={0} aria-label="限定通话前几秒" value={r.withinSec ?? 0} onChange={(e) => setRule(r.id, { withinSec: Math.max(0, Number(e.target.value) || 0) })} /><span className="k-muted">秒（0=不限）</span></label>}
              {kind === 'keyword' && <>
                <label className="cq-field"><span className="k-muted">至少</span><input type="number" className="k-input cq-num" min={0} aria-label="至少出现几次" value={r.min ?? 0} onChange={(e) => setRule(r.id, { min: Math.max(0, Number(e.target.value) || 0) })} /><span className="k-muted">次</span></label>
                <label className="cq-field"><span className="k-muted">最多</span><input type="number" className="k-input cq-num" min={0} aria-label="最多出现几次" value={r.max ?? 0} onChange={(e) => setRule(r.id, { max: Math.max(0, Number(e.target.value) || 0) })} /><span className="k-muted">次（0=不限）</span></label>
              </>}
              <button className="k-icon-btn" aria-label={`删除规则 ${r.name}`} onClick={() => update((c) => ({ ...c, rules: c.rules.filter((x) => x.id !== r.id) }))}><Trash2 size={14} /></button>
            </div>
          ))}
          {!config.rules.some((r) => r.kind === kind) && <div className="k-muted cq-none">还没有规则，点右上「添加」。</div>}
        </div>
      ))}
      <div className="k-muted cq-foot">词与词之间用逗号、顿号或换行分隔。匹配时忽略标点、空格和英文大小写。语音识别会有同音字错误（例如「工号」识别成「公号」），请把常见的误识别也加进同义词。</div>
    </section>
  );
}

/** 词组输入：输入过程中保留原文，失焦后才拆分，避免边打边被改写 */
function WordsInput({ value, onCommit }: { value: string[]; onCommit: (w: string[]) => void }) {
  const joined = value.join('、');
  const [text, setText] = useState(joined);
  useEffect(() => setText(joined), [joined]);
  return <input className="k-input cq-words" aria-label="词 / 同义词" placeholder="词或同义词，用顿号分隔" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(parseWords(text))} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />;
}
