import { Activity, RefreshCw, Search, Server, Terminal, Radio, Wrench, Layers } from 'lucide-react';
import type { BoardSnapshot, ChannelStatus } from '../types';

interface Props {
  snapshot: BoardSnapshot | null;
  channels?: ChannelStatus[];
  query: string;
  onQueryChange: (v: string) => void;
  onRefresh: () => void;
  onTools: () => void;
  /** 切到架构与版本页（再点一次返回看板）。 */
  onArchitecture: () => void;
  /** 当前是否已经在架构页：按钮高亮、文案变"返回"。 */
  archOpen: boolean;
  /** 版本变了但还没看过架构页：入口亮一个小圆点。 */
  hasUpdate: boolean;
  loading: boolean;
}

function HealthDot({ ok, label, icon }: { ok: boolean; label: string; icon: React.ReactNode }): React.ReactElement {
  return (
    <div
      className="flex items-center gap-1.5 rounded-full border border-line bg-black/[0.03] px-2.5 py-1"
      title={`${label}：${ok ? '在线' : '离线'}`}
    >
      {icon}
      <span className="text-[11px] text-ink-muted">{label}</span>
      <span className="relative flex h-1.5 w-1.5">
        {ok && <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-state-ok" />}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${ok ? 'bg-state-ok' : 'bg-state-bad'}`} />
      </span>
    </div>
  );
}

export default function TopBar({
  snapshot,
  channels,
  query,
  onQueryChange,
  onRefresh,
  onTools,
  onArchitecture,
  archOpen,
  hasUpdate,
  loading,
}: Props): React.ReactElement {
  const health = snapshot?.health;

  return (
    <header className="fixed inset-x-0 top-0 z-30 h-14 border-b border-line bg-surface-900/80 backdrop-blur-xl">
      <div className="flex h-full items-center gap-4 px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary-deep shadow-lift">
            <Activity size={15} className="text-white" />
          </div>
          <div className="leading-tight">
            <div className="flex items-baseline gap-1.5">
              <span className="font-serif text-[17px] font-semibold tracking-tight text-ink">Revolver</span>
              <span
                className="rounded border border-line bg-black/[0.04] px-1 py-px font-mono text-[9px] leading-none text-ink-muted"
                title={`当前版本 ${__APP_VERSION__}`}
              >
                v{__APP_VERSION__}
              </span>
            </div>
            <div className="text-[10px] text-ink-muted">枪管是渠道，弹巢是会话</div>
          </div>
        </div>

        <div className="relative ml-2 hidden max-w-sm flex-1 items-center md:flex">
          <Search size={14} className="absolute left-3 text-ink-muted" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="搜索任务、员工或输出内容…"
            className="w-full rounded-lg border border-line bg-black/[0.03] py-1.5 pl-9 pr-3 text-[13px] text-ink outline-none transition placeholder:text-ink-muted/60 focus:border-primary/50 focus:bg-black/[0.04]"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {health && (
            <div className="hidden items-center gap-2 lg:flex">
              <HealthDot ok={health.pi} label="Pi" icon={<Terminal size={11} className="text-ink-muted" />} />
              <HealthDot ok={health.memoryServer} label="记忆服务" icon={<Server size={11} className="text-ink-muted" />} />
            </div>
          )}
          {channels && channels.length > 0 && (
            <div
              className="hidden items-center gap-1.5 rounded-full border border-line bg-black/[0.03] px-2.5 py-1 lg:flex"
              title={channels.map((c) => `${c.name}：${c.state}${c.error ? `（${c.error}）` : ''}`).join('\n')}
            >
              <Radio size={11} className="text-ink-muted" />
              <span className="text-[11px] text-ink-muted">渠道</span>
              <span
                className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                  channels.some((c) => c.state === 'running')
                    ? 'bg-state-ok'
                    : channels.some((c) => c.state === 'error')
                      ? 'bg-state-bad'
                      : 'bg-state-warn'
                }`}
              />
              <span className="font-mono text-[11px] text-ink-muted">
                {channels.filter((c) => c.state === 'running').length}/{channels.length}
              </span>
            </div>
          )}
          <button
            onClick={onArchitecture}
            title={archOpen ? '返回看板' : '架构与版本记录'}
            className={`relative flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition ${
              archOpen
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-line bg-black/[0.03] text-ink-muted hover:border-primary/40 hover:text-ink'
            }`}
          >
            <Layers size={13} />
            架构
            {hasUpdate && !archOpen && (
              <span
                className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                title="有新版本，点开看改了什么"
              />
            )}
          </button>
          <button
            onClick={onTools}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-black/[0.03] px-2.5 py-1.5 text-[12px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
          >
            <Wrench size={13} />
            工具
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-black/[0.03] px-2.5 py-1.5 text-[12px] text-ink-muted transition hover:border-primary/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            刷新
          </button>
        </div>
      </div>
    </header>
  );
}
