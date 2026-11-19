import type { TodoPhase, TodoView } from '../types';

/** 与后端一致：提前 24h 进入「到期」窗口；超过 dueAt 是「过期」。 */
export const LEAD_MS = 24 * 3600 * 1000;

/** 列表排序权重：过期最前，其次到期、执行中、未到期，最后是终态。 */
export const PHASE_RANK: Record<TodoPhase, number> = {
  overdue: 0,
  due: 1,
  running: 2,
  pending: 3,
  failed: 4,
  done: 5,
  dismissed: 6,
};

/** 与后端同一条派生规则：到期 / 过期不入库，只看 dueAt 与当前时间。 */
export function todoPhaseOf(t: TodoView, nowMs: number): TodoPhase {
  if (t.status !== 'pending') return t.status;
  const due = Date.parse(t.dueAt);
  if (!Number.isFinite(due)) return 'pending';
  if (nowMs > due) return 'overdue';
  if (nowMs >= due - LEAD_MS) return 'due';
  return 'pending';
}

/** `MM-DD HH:mm`：列表行里够用。 */
export function fmtDue(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `YYYY-MM-DD HH:mm`：详情里要能看全年份。 */
export function fmtFull(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 「还有 3 小时 / 已过 2 天」。比绝对时间更能让人判断紧不紧急。 */
export function relDue(iso: string, nowMs: number): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return '';
  const diff = d - nowMs;
  const abs = Math.abs(diff);
  const label =
    abs < 60_000
      ? '不到 1 分钟'
      : abs < 86_400_000
        ? `${Math.max(1, Math.round(abs / 3_600_000))} 小时`
        : `${Math.round(abs / 86_400_000)} 天`;
  return diff >= 0 ? `还有 ${label}` : `已过 ${label}`;
}

export const PHASE_LABEL: Record<TodoPhase, string> = {
  overdue: '已过期',
  due: '到期',
  running: '执行中',
  pending: '待办',
  failed: '执行失败',
  done: '已完成',
  dismissed: '已关闭',
};

export const PHASE_CHIP: Record<TodoPhase, string> = {
  overdue: 'bg-state-bad/15 text-state-bad ring-state-bad/30',
  due: 'bg-state-warn/15 text-state-warn ring-state-warn/30',
  running: 'bg-primary/15 text-primary ring-primary/30',
  pending: 'bg-black/[0.04] text-ink-muted ring-black/[0.08]',
  failed: 'bg-state-bad/15 text-state-bad ring-state-bad/30',
  done: 'bg-state-ok/15 text-state-ok ring-state-ok/30',
  dismissed: 'bg-black/[0.04] text-ink-muted ring-black/[0.08]',
};

/** 任务从哪来的（看板能看出"这条是我在飞书里随口留的"）。 */
export const SOURCE_LABEL: Record<string, string> = {
  im: '飞书对话',
  web: '看板',
  cli: '命令行',
  cron: '定时任务',
  api: 'API',
};
