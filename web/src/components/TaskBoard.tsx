import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Filter,
  Inbox,
  Pencil,
  Eraser,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Plus,
  Loader2,
  MessagesSquare,
} from 'lucide-react';
import type { SessionView, TaskSource } from '../types';
import { sourceMeta, formatAgo } from './statusMeta';
import { fmtTokens, fmtCost } from '../format';

interface Props {
  sessions: SessionView[];
  /** 筛选条件指纹：变化时回到第 1 页（轮询刷新不会打断翻页）。 */
  filterKey: string;
  /** 有未读结果的会话（`wakerId:sessionId`）。 */
  unreadKeys: Set<string>;
  sourceFilter: TaskSource | 'all';
  onSourceFilter: (v: TaskSource | 'all') => void;
  onOpen: (s: SessionView) => void;
  onRename: (s: SessionView) => void;
  onDelete: (s: SessionView) => void;
  /** 清空该会话的上下文（保留会话本身）。 */
  onClear: (s: SessionView) => void;
  onNewSession: () => void;
  /** 上方内容变化的指纹：变了就重新量一次列表可用高度。 */
  measureKey?: string;
}

const SOURCE_TABS: Array<{ value: TaskSource | 'all'; label: string }> = [
  { value: 'all', label: '全部来源' },
  { value: 'cli', label: '手动' },
  { value: 'cron', label: '定时' },
  { value: 'im', label: 'IM' },
  { value: 'web', label: '看板' },
  { value: 'api', label: 'API' },
];

/** 每页会话数。 */
const PAGE_SIZE = 20;

/**
 * 会话列表：看板的**主视图以会话为粒度**（每页 20 个，可翻页）。
 * **整行点击即打开对话**；改名/删除在会话名旁边。
 */
export default function TaskBoard({
  sessions,
  filterKey,
  unreadKeys,
  sourceFilter,
  onSourceFilter,
  onOpen,
  onRename,
  onDelete,
  onClear,
  onNewSession,
  measureKey,
}: Props): React.ReactElement {
  const [page, setPage] = useState(1);
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * 列表可用高度：**由视口实测**，不写死。
   *
   * 早先固定 42vh —— 大屏浪费、小屏又把下面挤爆。现在按"列表顶端到视口底部"算，
   * 屏幕多大就用多大；同时留 6% 底部呼吸空间。
   *
   * **保底 560px**（约两屏卡片）：待办与使用统计占了半屏之后，纯按"视口剩余"
   * 算只剩一条缝，翻两页就得滚。短了就往下延伸，让页面整体滚动，而不是把列表压扁。
   */
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const measure = (): void => {
      const el = listRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const breathe = Math.max(24, window.innerHeight * 0.06);
      setMaxHeight(Math.max(560, Math.floor(window.innerHeight - top - breathe)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // measureKey 变化（上方运行时面板出现/消失等）时重量一次
  }, [measureKey]);

  // 仅当筛选条件变化时回到第 1 页；后台轮询刷新不影响当前页
  useEffect(() => {
    setPage(1);
  }, [filterKey]);

  const totalPages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const cur = Math.min(page, totalPages);
  const items = sessions.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

  const pageBtn =
    'rounded-md border border-line p-1 text-ink-muted transition hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-35';
  const rowBtn = 'shrink-0 rounded p-0.5 text-ink-muted transition hover:text-primary';

  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
          <MessagesSquare size={13} className="text-primary" />
          对话记录
        </span>
        {/* 来源筛选收成下拉：一排 tab 会把标题和右侧操作挤成两行 */}
        <label className="flex items-center gap-1 rounded-lg border border-line bg-black/[0.03] px-2 py-1">
          <Filter size={12} className="text-ink-muted" />
          <select
            value={sourceFilter}
            onChange={(e) => onSourceFilter(e.target.value as TaskSource | 'all')}
            aria-label="按来源筛选会话"
            className="cursor-pointer bg-transparent pr-0.5 text-[12px] text-ink outline-none"
          >
            {SOURCE_TABS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onNewSession}
            className="flex items-center gap-1 rounded-lg border border-line bg-black/[0.03] px-2.5 py-1 text-[12px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
          >
            <Plus size={12} /> 新建会话
          </button>
          <span className="font-mono text-[11px] text-ink-muted">{sessions.length} 个会话</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(cur - 1)} disabled={cur <= 1} className={pageBtn} aria-label="上一页">
              <ChevronLeft size={13} />
            </button>
            <span className="font-mono text-[11px] text-ink-muted">
              {cur}/{totalPages}
            </span>
            <button onClick={() => setPage(cur + 1)} disabled={cur >= totalPages} className={pageBtn} aria-label="下一页">
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* 高度由视口实测（见上），内部滚动：既能用满屏幕，也不会把下面的面板推走 */}
      <div ref={listRef} style={{ maxHeight }} className="flex flex-col gap-1.5 overflow-y-auto pr-1">
        {items.map((s) => {
          const src = sourceMeta(s.source);
          const unread = unreadKeys.has(`${s.wakerId}:${s.sessionId}`);
          return (
            // 整行可点：点它直接打开这个会话的对话窗
            <div
              key={`${s.wakerId}:${s.sessionId}`}
              onClick={() => onOpen(s)}
              className="glass glass-hover cursor-pointer rounded-lg px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-px text-[10px] ring-1 ${src.chip}`}>{src.label}</span>
                {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-state-bad" title="有新结果" />}
                <span className="text-[13px] font-medium text-ink">{s.name}</span>
                {s.running && (
                  <span className="flex shrink-0 items-center gap-1 text-[10px] text-primary" title="正在运行">
                    <Loader2 size={11} className="animate-spin" />
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename(s);
                  }}
                  title="重命名会话"
                  aria-label="重命名会话"
                  className={rowBtn}
                >
                  <Pencil size={11} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear(s);
                  }}
                  title="清空该会话的上下文（保留会话）"
                  aria-label="清空会话上下文"
                  className={rowBtn}
                >
                  <Eraser size={11} />
                </button>
                <span className="font-mono text-[11px] text-ink-muted">{s.wakerName}</span>
                {s.origin === 'pi' && (
                  <span className="rounded bg-primary/15 px-1 py-px text-[10px] text-primary-deep ring-1 ring-primary/30">
                    Pi
                  </span>
                )}
                {s.externalKey && (
                  <span
                    className="rounded px-1 py-px text-[10px] text-ink-muted ring-1 ring-black/[0.08]"
                    title={s.externalKey}
                  >
                    外部会话
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10px] text-ink-muted">
                  {!!s.tokens && (
                    <span
                      title={`本会话累计 ${s.tokens.toLocaleString()} tokens，费用按模型价格表计算`}
                    >
                      {fmtTokens(s.tokens)} · {fmtCost(s.cost ?? 0)}
                    </span>
                  )}
                  <span>
                    {s.messageCount} 条 · {formatAgo(s.lastActiveAt)}
                  </span>
                </span>
                {/* 删除放到整行最右，和重命名拉开距离，避免误点。
                    默认会话是兜底会话，删了会被立刻重建，所以不给删除入口（用「清空」替代）。 */}
                {s.sessionId !== 'default' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s);
                    }}
                    title="删除会话"
                    aria-label="删除会话"
                    className="ml-1 shrink-0 rounded p-0.5 text-ink-muted transition hover:text-state-bad"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>

              {s.lastPrompt && (
                <div className="mt-1 line-clamp-1 text-[12px] leading-relaxed text-ink">{s.lastPrompt}</div>
              )}
              {s.lastResult && (
                <div className="mt-0.5 line-clamp-1 text-[11px] leading-relaxed text-ink-muted">{s.lastResult}</div>
              )}
            </div>
          );
        })}

        {!sessions.length && (
          <div className="glass flex flex-col items-center gap-2 rounded-xl px-4 py-12 text-center">
            <Inbox size={22} className="text-ink-muted" />
            <div className="text-[13px] text-ink">当前筛选条件下没有会话</div>
            <div className="text-[11px] text-ink-muted">点左侧员工卡片右侧的气泡，即可开始一个会话</div>
          </div>
        )}
      </div>
    </section>
  );
}
