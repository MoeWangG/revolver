import { useEffect, useMemo, useState } from 'react';
import { AlarmClock, Bot, ChevronDown, ChevronRight, Loader2, Plus, User, X } from 'lucide-react';
import type { TodoAssignee, TodoView, WakerSummary } from '../types';
import { createTodo, todoDismiss, todoDone, todoSnooze } from '../api';
import { PHASE_CHIP, PHASE_LABEL, PHASE_RANK, fmtDue, relDue, todoPhaseOf } from './todoMeta';
import TodoDetailDialog from './TodoDetailDialog';

interface Props {
  todos: TodoView[];
  wakers: WakerSummary[];
  /** 当前选中的员工：新建时作为默认值。 */
  defaultWakerId?: string | null;
  /** 变更后通知外层刷新。 */
  onChanged: () => void;
  /** 打开来源会话（详情里的「定位到来源消息」）；focusText 用于滚到那一条。 */
  onOpenSession?: (wakerId: string, sessionId: string, focusText?: string) => void;
}

/** datetime-local 的默认值：明天 09:00（本地）。 */
function defaultDueInput(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 待办：人类任务与 agent 任务同一个列表。
 *
 * 列表行只放摘要（标题 / 谁做 / 截止），**点整行打开详情**——全文、执行结果、
 * 以及「跳回留下它的那条对话」都在详情里。列表行里不做截断内容的展开，
 * 否则一条长待办会把整个面板撑开。
 *
 * 视觉规则（按紧急度递进，但都保持"呼吸"而非高频闪烁）：
 *  - 到期：橙黄渐变呼吸，只染卡片；
 *  - 过期：红色脉冲 + 左侧色条；
 *  - 系统开启「减少动态效果」时降级为静态底色（见 index.css）。
 */
export default function TodoPanel({
  todos,
  wakers,
  defaultWakerId,
  onChanged,
  onOpenSession,
}: Props): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);
  /** 正在看详情的那条。 */
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [wakerId, setWakerId] = useState(defaultWakerId ?? wakers[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(defaultDueInput);
  const [assignee, setAssignee] = useState<TodoAssignee>('human');

  // 相位随时间变化：不依赖轮询也能在到点那一刻变橙
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (defaultWakerId) setWakerId(defaultWakerId);
  }, [defaultWakerId]);

  /** 员工 id → 显示名：卡片上要写"@谁"，光有 id 看不出是人还是哪个 bot。 */
  const nameOf = useMemo(() => {
    const m = new Map(wakers.map((w) => [w.id, w.name]));
    return (id: string): string => m.get(id) ?? id;
  }, [wakers]);

  const sorted = useMemo(() => {
    return [...todos].sort((a, b) => {
      const pa = todoPhaseOf(a, now);
      const pb = todoPhaseOf(b, now);
      if (PHASE_RANK[pa] !== PHASE_RANK[pb]) return PHASE_RANK[pa] - PHASE_RANK[pb];
      return a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0;
    });
  }, [todos, now]);

  const active = sorted.filter((t) => todoPhaseOf(t, now) !== 'done' && todoPhaseOf(t, now) !== 'dismissed');
  const finished = sorted.filter((t) => todoPhaseOf(t, now) === 'done' || todoPhaseOf(t, now) === 'dismissed');
  const overdue = active.filter((t) => todoPhaseOf(t, now) === 'overdue').length;
  const dueNow = active.filter((t) => todoPhaseOf(t, now) === 'due').length;

  const opened = openId ? todos.find((t) => t.id === openId) ?? null : null;

  const run = async (id: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async (): Promise<void> => {
    if (!wakerId || !title.trim()) return setError('需要员工与任务标题');
    const at = new Date(due);
    if (!Number.isFinite(at.getTime())) return setError('截止时间格式不对');
    setBusy('new');
    setError(null);
    try {
      await createTodo({ wakerId, title: title.trim(), dueAt: at.toISOString(), assignee });
      setTitle('');
      setDue(defaultDueInput());
      setOpen(false);
      onChanged();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const renderCard = (t: TodoView): React.ReactElement => {
    const phase = todoPhaseOf(t, now);
    const anim = phase === 'overdue' ? 'todo-overdue' : phase === 'due' ? 'todo-due' : '';
    return (
      <div
        key={t.id}
        className={`cursor-pointer rounded-lg border border-line px-2.5 py-2 transition hover:border-primary/30 ${anim}`}
        onClick={() => setOpenId(t.id)}
        title="点开看详情 / 跳回来源对话"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded px-1.5 py-px text-[10px] ring-1 ${PHASE_CHIP[phase]}`}>{PHASE_LABEL[phase]}</span>
          {/* 谁来做：真人还是机器人，以及具体是谁 */}
          <span
            title={t.assignee === 'agent' ? '机器人到点自己做，结果发回原窗口' : '到点提醒真人处理'}
            className={`flex items-center gap-1 rounded px-1.5 py-px text-[10px] ring-1 ${
              t.assignee === 'agent'
                ? 'bg-primary/10 text-primary ring-primary/25'
                : 'bg-black/[0.04] text-ink-muted ring-black/[0.08]'
            }`}
          >
            {t.assignee === 'agent' ? <Bot size={10} /> : <User size={10} />}
            {t.assignee === 'agent' ? '机器人' : '真人'}
          </span>
          <span className="text-[13px] font-medium text-ink">{t.title}</span>
          <span className="font-mono text-[10px] text-ink-muted">
            {fmtDue(t.dueAt)} · {relDue(t.dueAt, now)}
          </span>
          <span className="ml-auto text-[10px] text-ink-muted">@{nameOf(t.wakerId)}</span>
        </div>

        {t.detail && <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-muted">{t.detail}</p>}
        {t.error && <p className="mt-1 line-clamp-1 text-[11px] text-state-bad">{t.error}</p>}

        {t.status === 'running' && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-primary">
            <Loader2 size={10} className="animate-spin" />
            正在执行…
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="glass flex h-full flex-col rounded-xl px-3.5 py-3">
      <header className="flex flex-wrap items-center gap-2">
        <AlarmClock size={13} className="text-primary" />
        <span className="text-[13px] font-medium text-ink">待办</span>
        <span className="font-mono text-[11px] text-ink-muted">
          {active.length} 个未完成
          {dueNow ? ` · ${dueNow} 到期` : ''}
          {overdue ? ` · ${overdue} 过期` : ''}
        </span>
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
          className="mt-2.5 flex flex-col gap-2 rounded-lg border border-line bg-black/[0.02] p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={wakerId}
              onChange={(e) => setWakerId(e.target.value)}
              className="rounded-md border border-line bg-surface-800 px-2 py-1 text-[12px] text-ink"
            >
              {wakers.length === 0 && <option value="">（没有员工）</option>}
              {wakers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1 rounded-md border border-line p-0.5">
              {(['human', 'agent'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setAssignee(v)}
                  className={`rounded px-2 py-0.5 text-[11px] transition ${
                    assignee === v ? 'bg-primary/20 text-primary' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {v === 'human' ? '真人做' : '机器人做'}
                </button>
              ))}
            </div>
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="要做什么？（例：给 Jennie 加悄悄话模式）"
            className="rounded-md border border-line bg-surface-800 px-2 py-1 text-[12px] text-ink placeholder:text-ink-muted/60"
          />
          <div className="flex items-center gap-2">
            <input
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              className="rounded-md border border-line bg-surface-800 px-2 py-1 font-mono text-[12px] text-ink"
            />
            <button
              type="submit"
              disabled={busy === 'new'}
              className="ml-auto rounded-md bg-primary px-3 py-1 text-[12px] text-white transition hover:bg-primary-deep disabled:opacity-50"
            >
              {busy === 'new' ? '保存中…' : '保存'}
            </button>
          </div>
          {error && <p className="text-[11px] text-state-bad">{error}</p>}
        </form>
      )}

      {error && !open && <p className="mt-2 text-[11px] text-state-bad">{error}</p>}

      {/* flex-1：待办为空时也撑满与使用统计同高，不塌成一条 */}
      <div className="mt-2 flex flex-1 flex-col gap-1.5">
        {active.length === 0 && !finished.length && (
          <p className="flex flex-1 items-center justify-center py-6 text-[12px] text-ink-muted">没有待办。</p>
        )}
        {active.map(renderCard)}

        {finished.length > 0 && (
          <button
            onClick={() => setShowDone((v) => !v)}
            className="mt-1 flex items-center gap-1 self-start text-[11px] text-ink-muted transition hover:text-ink"
          >
            {showDone ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            已完成 / 已关闭 {finished.length} 条
          </button>
        )}
        {showDone && finished.map(renderCard)}
      </div>

      {opened && (
        <TodoDetailDialog
          todo={opened}
          now={now}
          nameOf={nameOf}
          busy={busy === opened.id}
          error={error}
          onClose={() => setOpenId(null)}
          onDone={(note) => void run(opened.id, () => todoDone(opened.id, note))}
          onDismiss={() => void run(opened.id, () => todoDismiss(opened.id))}
          onSnooze={() => void run(opened.id, () => todoSnooze(opened.id))}
          onOpenSession={
            opened.sessionId && onOpenSession
              ? (focusText?: string) => {
                  onOpenSession(opened.wakerId, opened.sessionId!, focusText);
                  setOpenId(null);
                }
              : undefined
          }
        />
      )}

    </section>
  );
}
