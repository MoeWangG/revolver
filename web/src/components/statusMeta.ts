import type { TaskSource, TaskStatus } from '../types';

interface StatusMeta {
  label: string;
  /** 圆点颜色（tailwind class）。 */
  dot: string;
  /** 胶囊样式。 */
  chip: string;
}

export const STATUS_META: Record<TaskStatus, StatusMeta> = {
  arrived: { label: '已到达', dot: 'bg-state-idle', chip: 'bg-state-idle/15 text-state-idle ring-state-idle/30' },
  queued: { label: '排队中', dot: 'bg-state-idle', chip: 'bg-state-idle/15 text-state-idle ring-state-idle/30' },
  running: { label: '运行中', dot: 'bg-primary', chip: 'bg-primary/15 text-primary ring-primary/35' },
  awaiting: { label: '待确认', dot: 'bg-state-warn', chip: 'bg-state-warn/15 text-state-warn ring-state-warn/35' },
  success: { label: '成功', dot: 'bg-state-ok', chip: 'bg-state-ok/15 text-state-ok ring-state-ok/30' },
  failed: { label: '失败', dot: 'bg-state-bad', chip: 'bg-state-bad/15 text-state-bad ring-state-bad/30' },
  cancelled: { label: '已取消', dot: 'bg-state-idle', chip: 'bg-state-idle/15 text-state-idle ring-state-idle/30' },
};

export const SOURCE_META: Record<TaskSource, { label: string; chip: string }> = {
  cli: { label: '手动', chip: 'bg-black/[0.05] text-ink-muted ring-black/[0.08]' },
  cron: { label: '定时', chip: 'bg-[#7C93B8]/15 text-[#5F7899] ring-[#7C93B8]/30' },
  im: { label: 'IM', chip: 'bg-[#6B8E4E]/15 text-[#5A7A42] ring-[#6B8E4E]/30' },
  api: { label: 'API', chip: 'bg-[#C08A3E]/15 text-[#A5762F] ring-[#C08A3E]/30' },
  web: { label: '看板', chip: 'bg-primary/15 text-primary-deep ring-primary/30' },
};

const FALLBACK_STATUS: StatusMeta = { label: '未知', dot: 'bg-state-idle', chip: 'bg-black/[0.05] text-ink-muted ring-black/[0.08]' };
const FALLBACK_SOURCE = { label: '其他', chip: 'bg-black/[0.05] text-ink-muted ring-black/[0.08]' };

/** 安全取值：未知枚举不再导致整页崩溃（看板对话产生的 source=web 就曾触发此问题）。 */
export function statusMeta(s: TaskStatus): StatusMeta {
  return STATUS_META[s] ?? FALLBACK_STATUS;
}
export function sourceMeta(s: TaskSource): { label: string; chip: string } {
  return SOURCE_META[s] ?? FALLBACK_SOURCE;
}

/** 毫秒转人类可读耗时。 */
export function formatDuration(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** 相对时间，用于"多久之前"。 */
export function formatAgo(iso?: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 消息时间：MM-DD HH:mm。 */
export function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatClock(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}
