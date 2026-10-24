// 主界面：导入录音 → 本机转写 → 按规则质检 → 看明细 → 导出 Excel。规则可随时修改，结果立即重算，不用重新转写。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { ArrowRight, Check, Download, FileAudio, FileText, FolderOpen, ListChecks, Loader2, Play, Plus, RotateCcw, Settings2, ShieldCheck, SlidersHorizontal, Trash2, X } from 'lucide-react';
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

const demoItems = (): Item[] => [
  ...DEMO.map((d, i): Item => ({ id: `d${i}`, path: `/示例/${d.name}`, name: d.name, status: 'ok', ratio: 1, text: '', segs: d.segs, duration: d.duration })),
  { id: 'd8', path: '/示例/客户回访-下午场.mp3', name: '客户回访-下午场.mp3', status: 'run', ratio: 0.42, text: '正在识别：第 2 / 5 段' },
  { id: 'd9', path: '/示例/备用录音.wav', name: '备用录音.wav', status: 'wait', ratio: 0, text: '' },
];

export function Main({ ctx }: { ctx?: Ctx }) {
  const [items, setItems] = useState<Item[]>(isPreview && new URLSearchParams(location.search).get('state') !== 'empty' ? demoItems() : []);
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
  const [sel, setSel] = useState<string | null>(isPreview ? 'd1' : null);
  const current = items.find((i) => i.id === sel) ?? done.find((i) => !reports.get(i.id)!.passed) ?? done[0];
  return (
    <div className="cq2" data-state={items.length ? 'has' : 'empty'}>
      <div className="cq2-bar">
        <div className="cq2-seg" role="tablist" aria-label="功能">
          <button role="tab" aria-selected={tab === 'result'} className={tab === 'result' ? 'on' : ''} onClick={() => setTab('result')}><ListChecks size={15} />质检结果</button>
          <button role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}><SlidersHorizontal size={15} />质检规则 {config.rules.length}</button>
        </div>
        <span className="cq-sp" />
        <button className="k-btn" disabled={running} onClick={async () => add(await pickFiles(AUDIO_EXTENSIONS, '录音'))}><Plus size={15} />添加录音</button>
        <button className="k-btn" disabled={running || !items.length} onClick={() => { setItems([]); setMsg(null); setSel(null); }}>清空</button>
        <details className="cq2-set">
          <summary className="k-btn"><Settings2 size={15} />识别设置</summary>
          <div className="cq2-pop">
            <label className="cq-opt"><span className="k-label">识别模型（中文）</span>
              <select className="k-input" value={prefs.model} disabled={running} onChange={(e) => setPref('model', e.target.value)}>{MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
            </label>
            <span className="k-muted">{prefs.localDir ? <>本地模型文件夹：<span title={prefs.localDir}>{baseName(prefs.localDir)}</span></> : '模型首次使用自动下载，之后离线可用。'}</span>
            <div className="cq2-pop-row">
              <button className="k-btn" disabled={running} onClick={async () => { const d = await pickFolder(); if (d) setPref('localDir', d); }}><FolderOpen size={14} aria-hidden />指定本地模型文件夹</button>
              {prefs.localDir && <button className="k-btn" disabled={running} onClick={() => setPref('localDir', '')}>改回自动下载</button>}
            </div>
          </div>
        </details>
        {tab === 'result' && done.length > 0 && <button className="k-btn" onClick={exportXlsx}><Download size={15} />导出 Excel</button>}
        {running ? <button className="k-btn primary" onClick={() => abort.current?.abort()}>暂停</button> : <button className="k-btn primary" disabled={!ctx || !waiting} onClick={start}><Play size={15} />{items.some((i) => i.status === 'err') && !items.some((i) => i.status === 'wait') ? '重试失败的' : '开始转写并质检'}</button>}
      </div>
      {msg && <div className={`cq-msg ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</div>}

      {tab === 'rules' ? <Rules config={config} update={updateConfig} /> : !items.length ? <Intro hover={hover} onPick={async () => add(await pickFiles(AUDIO_EXTENSIONS, '录音'))} /> : (
        <div className="cq2-work">
          <aside className="cq2-side">
            <div className="cq2-stats">
              <div><b className="k-num">{stat.total}</b><span>已质检</span></div>
              <div className="ok"><b className="k-num">{stat.pass}</b><span>合格</span></div>
              <div className="bad"><b className="k-num">{stat.total - stat.pass}</b><span>不合格</span></div>
              <div><b className="k-num">{stat.avg}</b><span>平均分</span></div>
            </div>
            <ul className="cq2-list">
              {items.map((it) => {
                const r = reports.get(it.id);
                const on = current?.id === it.id;
                return (
                  <li key={it.id}>
                    <button className={`cq2-call${on ? ' on' : ''}${r && !r.passed ? ' bad' : ''}`} aria-current={on} disabled={!r && it.status !== 'err'} onClick={() => setSel(it.id)}>
                      {r ? <span className={`cq2-score ${r.passed ? 'ok' : 'bad'}`}><b className="k-num">{r.score}</b></span> : <span className="cq2-score wait">{it.status === 'run' ? <Loader2 size={16} className="k-spin" /> : it.status === 'err' ? <X size={16} /> : <FileAudio size={16} />}</span>}
                      <span className="cq2-call-main">
                        <b className="k-ellipsis" title={it.path}>{it.name}</b>
                        {r ? <small className="k-muted k-ellipsis">{mmss(it.duration ?? 0)} · {problems(r)}</small>
                          : it.status === 'run' ? <><ProgressBar ratio={it.ratio} label={it.text} /><small className="k-muted">{it.text}</small></>
                          : it.status === 'err' ? <small className="cq-err">{it.error}</small> : <small className="k-muted">等待转写</small>}
                      </span>
                      <span role="button" tabIndex={0} className="k-icon-btn" aria-label={`移除 ${it.name}`} aria-disabled={running && it.status === 'run'} onClick={(e) => { e.stopPropagation(); if (!(running && it.status === 'run')) setItems((c) => c.filter((i) => i.id !== it.id)); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); if (!(running && it.status === 'run')) setItems((c) => c.filter((i) => i.id !== it.id)); } }}><Trash2 size={14} /></span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
          <section className="cq2-sheet">
            {current && reports.get(current.id) ? <Detail key={current.id} item={current} report={reports.get(current.id)!} passScore={config.passScore} /> : <div className="cq2-wait k-muted">转写完成后，在这里看每通录音的质检单。</div>}
          </section>
        </div>
      )}
    </div>
  );
}

/** 没有录音时：讲清楚「录音 → 文字 → 对照规则 → 得分」 */
function Intro({ hover, onPick }: { hover: boolean; onPick: () => void }) {
  return (
    <div className={`cq2-intro${hover ? ' hover' : ''}`}>
      <ol className="cq2-flow" aria-label="质检流程">
        <li><span><FileAudio size={22} /></span><b>通话录音</b><small>mp3、m4a、wav 等</small></li>
        <ArrowRight size={20} className="cq2-arr" />
        <li><span><FileText size={22} /></span><b>本机转成文字</b><small>不联网、不用显卡</small></li>
        <ArrowRight size={20} className="cq2-arr" />
        <li><span><ShieldCheck size={22} /></span><b>对照你的规则</b><small>必说话术、违禁词、关键词</small></li>
        <ArrowRight size={20} className="cq2-arr" />
        <li className="end"><span className="score"><b className="k-num">86</b></span><b>得分与明细</b><small>合格或不合格，可导出 Excel</small></li>
      </ol>
      <h2>{hover ? '松开鼠标，开始添加' : '把通话录音拖进来'}</h2>
      <p className="k-muted">不区分坐席和客户，整通录音按一份文字稿检查。规则可以随时改，结果立即重算，不用重新转写。</p>
      <button className="k-btn primary" onClick={onPick}><Plus size={15} />添加录音</button>
    </div>
  );
}

function Detail({ item, report, passScore }: { item: Item; report: Report; passScore: number }) {
  const hitTimes = new Set(report.results.flatMap((r) => r.hits.filter(() => r.rule.kind === 'banned').map((h) => h.at)));
  const total = Math.max(item.duration ?? 0, ...item.segs!.map((s) => s.end), 1);
  const pos = (t: number) => `${Math.min(100, (t / total) * 100)}%`;
  const failed = report.results.filter((r) => r.failed);
  const bannedHits = report.results.filter((r) => r.rule.kind === 'banned').reduce((n, r) => n + r.count, 0);
  const missed = report.results.filter((r) => r.rule.kind === 'required' && r.failed).length;
  return (
    <div className="cq2-detail">
      <header className={`cq2-head ${report.passed ? 'ok' : 'bad'}`}>
        <div className="cq2-big"><b className="k-num">{report.score}</b><span>分</span></div>
        <div className="cq2-verdict">
          <span className={`cq-tag ${report.passed ? 'ok' : 'err'}`}>{report.passed ? '合格' : '不合格'}</span>
          <h2 className="k-ellipsis" title={item.name}>{item.name}</h2>
          <p className="k-muted">时长 {mmss(item.duration ?? total)} · 满分 100，{passScore} 分及以上合格 · {failed.length ? `${failed.length} 条规则不达标` : '全部规则达标'}</p>
        </div>
        <dl className="cq2-mini">
          <div><dt>命中违禁词</dt><dd className={`k-num${bannedHits ? ' bad' : ''}`}>{bannedHits}</dd></div>
          <div><dt>漏说话术</dt><dd className={`k-num${missed ? ' bad' : ''}`}>{missed}</dd></div>
        </dl>
      </header>

      <div className="cq2-line" role="img" aria-label="通话时间线：说话的位置和规则命中的位置">
        <div className="cq2-track">
          {item.segs!.map((s, i) => <i key={i} className={`talk${hitTimes.has(s.start) ? ' bad' : ''}`} style={{ left: pos(s.start), width: `max(2px, ${((s.end - s.start) / total) * 100}%)` }} />)}
          {report.results.flatMap((r) => r.hits.map((h, i) => <b key={`${r.rule.id}${i}`} className={`pin ${r.rule.kind}`} style={{ left: pos(h.at) }} title={`${mmss(h.at)} ${r.rule.name}：${h.word}`} />))}
        </div>
        <div className="cq2-ticks k-num"><span>00:00</span><span>{mmss(total / 2)}</span><span>{mmss(total)}</span></div>
        <div className="cq2-legend"><span><i className="talk" />说话</span><span><i className="pin banned" />违禁词</span><span><i className="pin required" />必说话术</span><span><i className="pin keyword" />关键词</span></div>
      </div>

      <ul className="cq2-checks">
        {report.results.map((r) => (
          <li key={r.rule.id} className={r.failed ? 'bad' : ''}>
            <span className="cq2-ico" aria-label={r.failed ? '不达标' : '达标'}>{r.failed ? <X size={14} /> : <Check size={14} />}</span>
            <span className="cq2-chk-main">
              <span className="cq2-chk-head"><span className={`cq-kind ${r.rule.kind}`}>{KIND_NAME[r.rule.kind]}</span><b>{r.rule.name}</b></span>
              <span className={r.failed ? 'cq-err' : 'k-muted'}>{r.note}{r.deduct ? `，扣 ${r.deduct} 分` : ''}</span>
              {r.hits.length > 0 && <span className="cq-hits">{r.hits.slice(0, 6).map((h, i) => <span key={i} className="cq-hit" title={h.context}><span className="k-num">{mmss(h.at)}</span> {h.word}</span>)}{r.hits.length > 6 && <span className="k-muted"> 等 {r.hits.length} 处</span>}</span>}
            </span>
            {r.deduct > 0 && <b className="cq2-deduct k-num">−{r.deduct}</b>}
          </li>
        ))}
      </ul>

      <h3 className="cq2-h3">转写文字 <span className="k-muted">红底是命中违禁词的那句话；识别可能有错字，请抽查原声</span></h3>
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
