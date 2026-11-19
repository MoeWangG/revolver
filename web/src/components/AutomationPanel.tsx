import { useState } from 'react';
import { CalendarClock, Plus, Trash2, Loader2, X } from 'lucide-react';
import type { Automation, WakerSummary } from '../types';
import { createAutomation, removeAutomation, toggleAutomation } from '../api';

interface Props {
  wakers: WakerSummary[];
  automations: Automation[];
  /** 执行统计：成功 / 失败次数，以及启用中的任务数（计划中）。 */
  stats?: { success: number; failed: number; planned: number };
  /** 变更后通知外层刷新（App 会重新拉取看板数据）。 */
  onChanged: () => void;
}

/** 常用 cron 预设，省得记五个星号。 */
const PRESETS = [
  { label: '每天 9:00', cron: '0 9 * * *' },
  { label: '每 30 分钟', cron: '*/30 * * * *' },
  { label: '每小时', cron: '0 * * * *' },
  { label: '工作日 9:00', cron: '0 9 * * 1-5' },
];

function cronOf(a: Automation): string {
  return a.triggers.find((t) => t.kind === 'cron')?.cron ?? '—';
}

/** 定时任务：谁、什么时候、做什么，以及启停与删除。 */
export default function AutomationPanel({ wakers, automations, stats, onChanged }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [wakerId, setWakerId] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    if (!wakerId) return setError('请选择员工');
    if (!cron.trim()) return setError('请填写 cron 表达式');
    if (!prompt.trim()) return setError('请填写到点后要做的事');
    setBusy(true);
    try {
      await createAutomation({ wakerId, cron: cron.trim(), prompt: prompt.trim(), name: name.trim() || undefined });
      // 只清掉任务描述，保留员工与 cron 便于连续建多个
      setPrompt('');
      setName('');
      setOpen(false);
      onChanged();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass flex h-full flex-col rounded-xl px-3.5 py-3">
      <header className="flex flex-wrap items-center gap-2">
        <CalendarClock size={13} className="text-primary" />
        <span className="text-[13px] font-medium text-ink">定时任务</span>
        <span className="font-mono text-[11px] text-ink-muted">{automations.length} 个</span>
        {stats && automations.length > 0 && (
          <span
            className="font-mono text-[11px] text-ink-muted"
            title="已完成 / 失败 = 这些任务历史执行次数；计划中 = 启用中的任务数"
          >
            · 已完成 {stats.success} · 失败 {stats.failed} · 计划中 {stats.planned}
          </span>
        )}
        <button
          onClick={() => {
            setOpen((v) => !v);
            setError(null);
          }}
          className="ml-auto flex items-center gap-1 rounded-md border border-line bg-black/[0.03] px-2 py-1 text-[11px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
        >
          {open ? <X size={11} /> : <Plus size={11} />}
          {open ? '取消' : '新建'}
        </button>
      </header>

      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="mt-2.5 flex flex-col gap-2 rounded-lg border border-line bg-black/[0.02] p-2.5"
        >
          <div className="flex flex-wrap gap-2">
            <select
              value={wakerId}
              onChange={(e) => setWakerId(e.target.value)}
              className="rounded-md border border-line bg-surface-900 px-2 py-1 text-[12px] text-ink outline-none focus:border-primary/50"
            >
              <option value="">选择员工…</option>
              {wakers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="cron，如 0 9 * * *"
              className="w-40 rounded-md border border-line bg-black/[0.03] px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-primary/50"
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="任务名（可选）"
              className="min-w-32 flex-1 rounded-md border border-line bg-black/[0.03] px-2 py-1 text-[12px] text-ink outline-none focus:border-primary/50"
            />
          </div>

          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setCron(p.cron)}
                className={`rounded-md px-2 py-0.5 text-[10px] transition ${
                  cron === p.cron ? 'bg-primary/20 text-primary' : 'bg-black/[0.04] text-ink-muted hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder="到点后让它做什么？例如：检查昨日数据并出一份简报"
            className="resize-none rounded-md border border-line bg-black/[0.03] px-2 py-1.5 text-[12px] leading-relaxed text-ink outline-none focus:border-primary/50"
          />

          {error && <div className="text-[11px] text-state-bad">{error}</div>}

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-muted">cron 按 Asia/Shanghai 解释</span>
            <button
              type="submit"
              disabled={busy}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-primary-deep disabled:opacity-40"
            >
              {busy && <Loader2 size={11} className="animate-spin" />}
              创建
            </button>
          </div>
        </form>
      )}

      {/* flex-1 + 内部滚动：与对话列表同高，任务多了也不把行高撑开 */}
      <div className="mt-2.5 flex flex-1 flex-col gap-1.5 overflow-y-auto">
        {automations.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-black/[0.02] px-2.5 py-1.5"
          >
            <button
              onClick={() => {
                void toggleAutomation(a.id, !a.enabled).then(onChanged);
              }}
              title={a.enabled ? '点击停用' : '点击启用'}
              aria-label={a.enabled ? '停用' : '启用'}
              className={`relative h-3.5 w-6 shrink-0 rounded-full transition ${a.enabled ? 'bg-state-ok' : 'bg-black/[0.15]'}`}
            >
              <span
                className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all ${
                  a.enabled ? 'left-3' : 'left-0.5'
                }`}
              />
            </button>
            <span className={`text-[12px] ${a.enabled ? 'text-ink' : 'text-ink-muted line-through'}`}>{a.name}</span>
            <code className="rounded bg-black/[0.05] px-1 font-mono text-[10px] text-ink-muted">{cronOf(a)}</code>
            <span className="text-[10px] text-ink-muted">{a.wakerId}</span>
            <span className="ml-auto font-mono text-[10px] text-ink-muted">已运行 {a.runCount}</span>
            <button
              onClick={() => {
                if (window.confirm(`删除定时任务「${a.name}」？`)) void removeAutomation(a.id).then(onChanged);
              }}
              title="删除"
              aria-label="删除定时任务"
              className="shrink-0 rounded p-0.5 text-ink-muted transition hover:text-state-bad"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}

        {!automations.length && !open && (
          <div className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-[11px] text-ink-muted">
            还没有定时任务。点右上「新建」，让员工按点自己干活。
          </div>
        )}
      </div>
    </section>
  );
}
