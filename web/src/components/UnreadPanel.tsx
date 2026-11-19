import { Inbox, BellRing, CheckCheck } from 'lucide-react';
import type { SessionView } from '../types';
import { formatAgo, sourceMeta } from './statusMeta';

interface Props {
  /** **全量**会话（不受左侧员工筛选影响）——未读是全局视角。 */
  sessions: SessionView[];
  /** 有未读结果的会话（`wakerId:sessionId`）。 */
  unreadKeys: Set<string>;
  /** 员工 id → 显示名。 */
  wakerNames: Record<string, string>;
  /** 是否把 IM 来源的会话排除在未读之外（默认是）。 */
  ignoreIm?: boolean;
  /** 切换上面那个开关。 */
  onToggleIgnoreIm?: (v: boolean) => void;
  onOpen: (s: SessionView) => void;
  /** 全部标为已读。 */
  onMarkAll: () => void;
}

/**
 * 未读会话：把"有新结果还没看"的会话集中到一处，一眼扫完再决定看哪个。
 *
 * 与左侧员工卡上的红点角标互为补充——角标告诉你"谁有"，这里告诉你"具体是哪几条、
 * 最后说了什么"。点击即打开对话并自动标为已读。
 *
 * **IM 来源默认不计未读**：那些结果已经发回飞书那条对话，人在飞书里看过一遍了，
 * 再标一次红点就是让人把读过的消息重读一遍（用户 2026-10-12 提的）。
 * 开关留在这里，想改回来点一下即可。
 */
export default function UnreadPanel({
  sessions,
  unreadKeys,
  wakerNames,
  ignoreIm = true,
  onToggleIgnoreIm,
  onOpen,
  onMarkAll,
}: Props): React.ReactElement {
  const unread = sessions
    .filter((s) => unreadKeys.has(`${s.wakerId}:${s.sessionId}`))
    .sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));

  return (
    <section className="glass flex min-w-0 flex-col rounded-xl px-3.5 py-3">
      <header className="flex items-center gap-2">
        <BellRing size={13} className={unread.length ? 'text-state-bad' : 'text-primary'} />
        <span className="text-[13px] font-medium text-ink">未读会话</span>
        <span className="font-mono text-[11px] text-ink-muted">{unread.length} 个</span>
        {unread.length > 0 && (
          <button
            type="button"
            onClick={onMarkAll}
            className="ml-auto flex items-center gap-1 rounded-md border border-line px-1.5 py-[2px] text-[10px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
          >
            <CheckCheck size={10} /> 全部已读
          </button>
        )}
      </header>

      {/* IM 结果已经发到飞书了，默认不在这儿再标一次未读；想改回来点左侧那个开关 */}
      <button
        type="button"
        onClick={() => onToggleIgnoreIm?.(!ignoreIm)}
        title={
          ignoreIm
            ? 'IM（飞书）的结果已经发回那条对话，你在飞书里看过就不在这儿重复标未读'
            : '目前把 IM 的结果也计入未读'
        }
        className="mt-1.5 flex items-center gap-1 self-start rounded-md border border-line px-1.5 py-[2px] text-[10px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${ignoreIm ? 'bg-state-ok' : 'bg-ink-muted/40'}`} />
        IM 不计未读{ignoreIm ? '（已开）' : '（已关）'}
      </button>

      <div className="mt-2 flex max-h-[26vh] flex-col gap-1 overflow-y-auto pr-1">
        {unread.map((s) => {
          const src = sourceMeta(s.source);
          return (
            <button
              key={`${s.wakerId}:${s.sessionId}`}
              type="button"
              onClick={() => onOpen(s)}
              className="glass glass-hover rounded-lg px-2.5 py-1.5 text-left"
            >
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-state-bad" />
                <span className="truncate text-[12px] font-medium text-ink">
                  {wakerNames[s.wakerId] ?? s.wakerId}
                </span>
                <span className="shrink-0 text-[11px] text-ink-muted">·</span>
                <span className="min-w-0 truncate text-[11px] text-ink-muted">{s.name}</span>
                <span className={`ml-auto shrink-0 rounded px-1 py-px text-[10px] ring-1 ${src.chip}`}>{src.label}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] leading-relaxed text-ink-muted">
                  {s.lastResult || s.lastPrompt || '（无内容）'}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-ink-muted">{formatAgo(s.lastActiveAt)}</span>
              </div>
            </button>
          );
        })}

        {!unread.length && (
          <div className="flex flex-col items-center gap-1.5 py-6 text-center">
            <Inbox size={18} className="text-ink-muted opacity-60" />
            <div className="text-[12px] text-ink-muted">没有未读会话</div>
          </div>
        )}
      </div>
    </section>
  );
}
