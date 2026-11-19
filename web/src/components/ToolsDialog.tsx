import { useCallback, useEffect, useState } from 'react';
import { X, Wrench, ExternalLink, Trash2, Play, Pause, Loader2, CalendarClock, Coffee } from 'lucide-react';
import {
  fetchPlugins,
  fetchAutomations,
  toggleAutomation,
  removeAutomation,
  fetchWakers,
  createAutomation,
  fetchPower,
  savePreventSleep,
} from '../api';
import type { WakerBrief } from '../api';
import type { Automation, PluginEntry, SleepGuardStatus } from '../types';

interface Props {
  onClose: () => void;
}

/** 开关控件（原生 checkbox 太像表单，这里用轨道式，跟"系统开关"的语义更贴）。 */
function Switch(props: { on: boolean; disabled?: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      role="switch"
      aria-checked={props.on}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${
        props.on ? 'bg-primary' : 'bg-black/[0.18]'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          props.on ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}

/** 把定时任务的触发器转成可读文本。 */
function triggerText(a: Automation): string {
  return a.triggers
    .map((t) => (t.kind === 'cron' ? t.cron ?? 'cron' : t.kind === 'once' ? `一次 @ ${t.at ?? ''}` : t.kind))
    .join(' / ');
}

/**
 * 工具弹窗：三个 tab —— 插件入口（跳转本机已有的 pi 页面）、定时任务（启停/删除）、
 * 系统（常驻防睡眠开关）。
 */
export default function ToolsDialog({ onClose }: Props): React.ReactElement {
  const [tab, setTab] = useState<'plugins' | 'cron' | 'system'>('plugins');
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [autos, setAutos] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [wakers, setWakers] = useState<WakerBrief[]>([]);
  const [form, setForm] = useState({ wakerId: '', cron: '0 9 * * *', prompt: '', name: '' });
  const [creating, setCreating] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  // 常驻防睡眠
  const [power, setPower] = useState<SleepGuardStatus | null>(null);
  const [powerBusy, setPowerBusy] = useState(false);
  const [powerErr, setPowerErr] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [p, a, w, pw] = await Promise.all([
        fetchPlugins().catch(() => [] as PluginEntry[]),
        fetchAutomations().catch(() => [] as Automation[]),
        fetchWakers().catch(() => [] as WakerBrief[]),
        fetchPower().catch(() => null),
      ]);
      setPlugins(p);
      setAutos(a);
      setWakers(w);
      setPower(pw);
      setForm((f) => (f.wakerId || !w.length ? f : { ...f, wakerId: w[0]!.id }));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 切换常驻防睡眠。**以服务端返回的状态为准**：不支持的环境里开关会被记下但断言不会起来。 */
  const togglePower = useCallback(async (): Promise<void> => {
    if (!power || powerBusy) return;
    setPowerBusy(true);
    setPowerErr(null);
    try {
      setPower(await savePreventSleep(!power.enabled));
    } catch (e) {
      setPowerErr((e as Error)?.message ?? '切换失败');
    } finally {
      setPowerBusy(false);
    }
  }, [power, powerBusy]);

  const create = useCallback(async (): Promise<void> => {
    if (!form.wakerId || !form.cron.trim() || !form.prompt.trim()) {
      setFormErr('请选择员工，并填写 cron 表达式与任务描述');
      return;
    }
    setCreating(true);
    setFormErr(null);
    try {
      await createAutomation({
        name: form.name.trim() || undefined,
        wakerId: form.wakerId,
        cron: form.cron.trim(),
        prompt: form.prompt.trim(),
      });
      setForm((f) => ({ ...f, prompt: '', name: '' }));
      await load();
    } catch (e) {
      setFormErr((e as Error)?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  }, [form, load]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (a: Automation): Promise<void> => {
      try {
        await toggleAutomation(a.id, !a.enabled);
        await load();
      } catch {
        /* 忽略 */
      }
    },
    [load],
  );

  const remove = useCallback(
    async (a: Automation): Promise<void> => {
      if (!window.confirm(`删除定时任务「${a.name}」？`)) return;
      try {
        await removeAutomation(a.id);
        await load();
      } catch {
        /* 忽略 */
      }
    },
    [load],
  );

  const iconBtn = 'rounded-md border border-line p-1.5 text-ink-muted transition hover:border-primary/40 hover:text-primary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={onClose} aria-label="关闭工具" />

      <div className="glass relative flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Wrench size={15} className="text-primary" />
          <div className="text-[14px] font-semibold text-ink">工具</div>
          <button onClick={onClose} className={`ml-auto ${iconBtn}`} aria-label="关闭">
            <X size={14} />
          </button>
        </div>

        <div className="flex items-center gap-1 border-b border-line px-4 py-2">
          {(
            [
              { v: 'plugins', label: '插件入口' },
              { v: 'cron', label: '定时任务' },
              { v: 'system', label: '系统' },
            ] as const
          ).map((t) => (
            <button
              key={t.v}
              onClick={() => setTab(t.v)}
              className={`rounded-md px-2.5 py-1 text-[12px] transition ${
                tab === t.v ? 'bg-primary/20 text-primary' : 'text-ink-muted hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-ink-muted">
              <Loader2 size={14} className="animate-spin" /> 载入中…
            </div>
          ) : tab === 'plugins' ? (
            <div className="flex flex-col gap-2">
              {plugins.map((p) => (
                <button
                  key={p.url}
                  onClick={() => window.open(p.url, '_blank', 'noopener')}
                  className="glass glass-hover flex items-center gap-3 rounded-xl px-3.5 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">{p.name}</div>
                    <div className="truncate text-[11px] text-ink-muted">{p.desc ?? p.url}</div>
                  </div>
                  <ExternalLink size={13} className="shrink-0 text-ink-muted" />
                </button>
              ))}
              {!plugins.length && <div className="py-8 text-center text-[12px] text-ink-muted">没有插件入口</div>}
              <div className="mt-1 text-[11px] text-ink-muted">清单可在 data/plugins.json 里增删。</div>
            </div>
          ) : tab === 'system' ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-xl border border-line bg-black/[0.02] p-3.5">
                <div className="flex items-start gap-3">
                  <Coffee size={15} className={`mt-0.5 ${power?.active ? 'text-primary' : 'text-ink-muted'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">禁止机器进入睡眠</div>
                    <div className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
                      常驻电源断言：系统不会因空闲挂起。开关记在 <code className="font-mono">data/config.json</code>
                      ，看板重启会自动恢复；关掉立刻释放。
                    </div>
                  </div>
                  <Switch
                    on={power?.enabled ?? false}
                    disabled={!power?.supported || powerBusy}
                    onClick={() => void togglePower()}
                  />
                </div>

                <div className="mt-2.5 border-t border-line pt-2 text-[11px] leading-relaxed">
                  <span className="text-ink-muted">状态：</span>
                  {power === null ? (
                    <span className="text-ink-muted">读不到（看板未响应）</span>
                  ) : power.active ? (
                    <span className="text-state-ok">
                      生效中 · pid {power.pid}
                      {power.since ? ` · 自 ${power.since.slice(0, 19).replace('T', ' ')}` : ''}
                    </span>
                  ) : power.enabled ? (
                    <span className="text-state-warn">开关已开，但断言没在跑</span>
                  ) : (
                    <span className="text-ink-muted">已关闭</span>
                  )}
                  {power?.note && <div className="mt-1 text-[10px] text-state-warn">{power.note}</div>}
                  {powerErr && <div className="mt-1 text-[10px] text-state-bad">{powerErr}</div>}
                </div>
              </div>

              <div className="text-[11px] leading-relaxed text-ink-muted">
                · 只防 <b className="text-ink">空闲睡眠</b>；<b className="text-ink">合盖睡眠拦不住</b>
                （电池供电时系统强制执行）——要合盖跑就接电源。
                <br />· 这是"一直不睡"。任务运行期间另有一套随 pi 进程起落的临时断言（
                <code className="font-mono">caffeinate -i -w &lt;pid&gt;</code>），不受此开关影响。
                <br />· 断言绑在看板进程上，所以看板停了它自动消失，不会留下后台残留。
                <br />· 验证：<code className="font-mono">pmset -g assertions | grep -i caffeinate</code>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="rounded-xl border border-line bg-black/[0.02] p-3">
                <div className="mb-2 text-[12px] font-medium text-ink">新建定时任务</div>
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <select
                      value={form.wakerId}
                      onChange={(e) => setForm((f) => ({ ...f, wakerId: e.target.value }))}
                      className="min-w-0 flex-1 rounded-lg border border-line bg-surface-800 px-2.5 py-2 text-[12px] text-ink outline-none focus:border-primary/50"
                    >
                      <option value="">选择员工…</option>
                      {wakers.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}（{w.id}）
                        </option>
                      ))}
                    </select>
                    <input
                      value={form.cron}
                      onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))}
                      placeholder="0 9 * * *"
                      className="w-32 shrink-0 rounded-lg border border-line bg-black/[0.03] px-2.5 py-2 font-mono text-[12px] text-ink outline-none focus:border-primary/50"
                    />
                  </div>
                  <input
                    value={form.prompt}
                    onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                    placeholder="任务描述，例如：生成昨日代码变更简报"
                    className="rounded-lg border border-line bg-black/[0.03] px-2.5 py-2 text-[12px] text-ink outline-none focus:border-primary/50"
                  />
                  {formErr && <div className="text-[11px] text-state-bad">{formErr}</div>}
                  <button
                    onClick={() => void create()}
                    disabled={creating}
                    className="self-start rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-primary-deep disabled:opacity-40"
                  >
                    {creating ? '创建中…' : '创建定时任务'}
                  </button>
                </div>
              </div>

              {autos.map((a) => (
                <div key={a.id} className="glass flex items-center gap-3 rounded-xl px-3.5 py-3">
                  <CalendarClock size={14} className={a.enabled ? 'text-primary' : 'text-ink-muted'} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-ink">{a.name}</span>
                      <span className="font-mono text-[10px] text-ink-muted">{a.wakerId}</span>
                      {!a.enabled && <span className="rounded px-1 text-[10px] text-ink-muted ring-1 ring-black/[0.08]">已停用</span>}
                    </div>
                    <div className="truncate text-[11px] text-ink-muted">
                      <code className="font-mono">{triggerText(a)}</code> · 已跑 {a.runCount} 次 · {a.promptTemplate}
                    </div>
                  </div>
                  <button onClick={() => void toggle(a)} title={a.enabled ? '停用' : '启用'} aria-label="启停" className={iconBtn}>
                    {a.enabled ? <Pause size={12} /> : <Play size={12} />}
                  </button>
                  <button
                    onClick={() => void remove(a)}
                    title="删除"
                    aria-label="删除"
                    className="rounded-md border border-line p-1.5 text-ink-muted transition hover:border-state-bad/40 hover:text-state-bad"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {!autos.length && (
                <div className="py-8 text-center text-[12px] text-ink-muted">
                  还没有定时任务。用 <code className="font-mono">waker cron add &lt;id&gt; "&lt;cron&gt;" "&lt;prompt&gt;"</code> 添加。
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
