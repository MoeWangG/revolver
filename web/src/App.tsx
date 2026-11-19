import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopBar from './components/TopBar';
import OverviewBar from './components/OverviewBar';
import WakerRail from './components/WakerRail';
import TaskBoard from './components/TaskBoard';
import UsagePanel from './components/UsagePanel';
import RuntimePanel from './components/RuntimePanel';
import AutomationPanel from './components/AutomationPanel';
import TodoPanel from './components/TodoPanel';
import NewWakerDialog from './components/NewWakerDialog';
import ImportAgentDialog from './components/ImportAgentDialog';
import AgentEditorDialog from './components/AgentEditorDialog';
import AgentChatDialog from './components/AgentChatDialog';
import ToolsDialog from './components/ToolsDialog';
import ArchitecturePage from './components/ArchitecturePage';
import {
  fetchBoard,
  fetchChannels,
  fetchSessionList,
  fetchUsage,
  fetchRuntime,
  fetchAutomations,
  renameSession,
  deleteSession,
  clearSession,
  createSession,
  archiveWaker,
} from './api';
import type { Automation, BoardSnapshot, ChannelStatus, RuntimeView, SessionView, TaskSource, UsageView } from './types';

/** 轮询间隔。看板是运维视角，5 秒足够实时又不至于打满本地 CPU。 */
const POLL_MS = 5000;
/** 使用统计要扫 pi 会话文件，刷新频率放宽。 */
const USAGE_POLL_MS = 30000;

/** 顶层视图。只有两个，不值得引路由库——hash 就够。 */
type View = 'board' | 'architecture';
const ARCH_HASH = '#/architecture';

/**
 * hash → 视图。
 *
 * 用 hash 而不是自绘 tab 状态：刷新、浏览器前进后退、把链接发给别人，
 * 这三种情况下"我在哪一页"都还成立，且不需要网关额外做路由。
 */
function readView(): View {
  return window.location.hash === ARCH_HASH ? 'architecture' : 'board';
}

export default function App(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [runtime, setRuntime] = useState<RuntimeView | null>(null);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedWaker, setSelectedWaker] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<TaskSource | 'all'>('all');
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** focusText：从待办跳过来时，要在会话里定位并高亮的那句原话。 */
  const [chatting, setChatting] = useState<{ wakerId: string; sessionId?: string; focusText?: string } | null>(
    null,
  );
  const [toolsOpen, setToolsOpen] = useState(false);
  /** 当前在哪个视图（看板 / 架构页）。 */
  const [view, setView] = useState<View>(readView);
  /** 上次看过架构页的版本：发版后顶栏入口亮小圆点，提示"去看改了什么"。 */
  const [seenVersion, setSeenVersion] = useState<string | null>(() => {
    try {
      return localStorage.getItem('waker.seenVersion');
    } catch {
      return null;
    }
  });
  /** 头像改动后自增，用于破除图片缓存。 */
  const [avatarVersion, setAvatarVersion] = useState(0);
  // 未读标记：记录每个会话"已读到哪个 lastActiveAt"。运行结束会刷新 lastActiveAt，于是重新变红点。
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('waker.seen') ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [snap, list, chans, autos, rt] = await Promise.all([
        fetchBoard(),
        fetchSessionList().catch(() => [] as SessionView[]),
        fetchChannels().catch(() => [] as ChannelStatus[]),
        fetchAutomations().catch(() => [] as Automation[]),
        fetchRuntime().catch(() => null),
      ]);
      setSnapshot(snap);
      setSessions(list);
      setChannels(chans);
      setAutomations(autos);
      setRuntime(rt);
      setError(null);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // hash 是视图的单一来源：刷新、前进后退、直接开链接都靠它
  useEffect(() => {
    const onHash = (): void => setView(readView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openArchitecture = useCallback((): void => {
    window.location.hash = ARCH_HASH;
  }, []);
  const closeArchitecture = useCallback((): void => {
    window.location.hash = '#/';
  }, []);

  // 打开架构页就记住"看过这一版"；圆点只在新版本出现时亮
  useEffect(() => {
    if (view !== 'architecture') return;
    setSeenVersion(__APP_VERSION__);
    try {
      localStorage.setItem('waker.seenVersion', __APP_VERSION__);
    } catch {
      /* 存储不可用就每次亮圆点，不影响使用 */
    }
  }, [view]);

  const hasUpdate = seenVersion !== null && seenVersion !== __APP_VERSION__;

  // 使用统计：跟随选中员工，频率低于看板轮询
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      // 半年（26 周）：热力图正好铺满一屏宽度，不用横向滚动也能看到趋势
      void fetchUsage(182, selectedWaker ?? undefined)
        .then((u) => {
          if (alive) setUsage(u);
        })
        .catch(() => {
          /* 统计失败不影响看板 */
        });
    };
    load();
    const timer = setInterval(load, USAGE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedWaker, avatarVersion]);

  const visible = useMemo(() => {
    let list = sessions;
    if (selectedWaker) list = list.filter((s) => s.wakerId === selectedWaker);
    if (sourceFilter !== 'all') list = list.filter((s) => s.source === sourceFilter);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.wakerId.toLowerCase().includes(q) ||
          (s.lastPrompt ?? '').toLowerCase().includes(q) ||
          (s.lastResult ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [sessions, selectedWaker, sourceFilter, query]);

  // 未读状态持久化到本地
  useEffect(() => {
    try {
      localStorage.setItem('waker.seen', JSON.stringify(seen));
    } catch {
      /* 存储不可用时忽略 */
    }
  }, [seen]);

  // 首次拿到会话时，把尚未记录的一律标为已读（避免一打开就全是红点）
  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current || !sessions.length) return;
    initedRef.current = true;
    setSeen((prev) => {
      const next = { ...prev };
      for (const s of sessions) {
        const k = `${s.wakerId}:${s.sessionId}`;
        if (!(k in next)) next[k] = s.lastActiveAt;
      }
      return next;
    });
  }, [sessions]);

  /**
   * IM 来源的会话不计未读（默认开）。
   *
   * 理由：IM 的结果**已经发回飞书那条对话**了，人在飞书里就看过一遍；
   * 看板再标一次红点，等于让人回到电脑上把读过的消息再"读"一遍。
   * 判据用 `SessionView.source`（= 最近一次活动的来源渠道），所以：
   * 最后一条是 IM → 不算未读；最后一条是在看板里跑的（web）→ 照旧算未读。
   * 混合会话也不会误伤。可在未读面板里关掉（存 localStorage）。
   */
  const [ignoreImUnread, setIgnoreImUnread] = useState<boolean>(
    () => localStorage.getItem('waker.unreadIgnoreIm') !== '0',
  );

  useEffect(() => {
    try {
      localStorage.setItem('waker.unreadIgnoreIm', ignoreImUnread ? '1' : '0');
    } catch {
      /* 存储不可用时忽略 */
    }
  }, [ignoreImUnread]);

  const unreadKeys = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (ignoreImUnread && s.source === 'im') continue;
      if (seen[`${s.wakerId}:${s.sessionId}`] !== s.lastActiveAt) set.add(`${s.wakerId}:${s.sessionId}`);
    }
    return set;
  }, [sessions, seen, ignoreImUnread]);

  /** 各员工名下"有新结果未看"的会话数，用于卡片角标。 */
  const unreadByWaker = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of sessions) {
      if (unreadKeys.has(`${s.wakerId}:${s.sessionId}`)) m[s.wakerId] = (m[s.wakerId] ?? 0) + 1;
    }
    return m;
  }, [sessions, unreadKeys]);

  const markSeen = useCallback((wakerId: string, sessionId: string, stamp: string): void => {
    setSeen((prev) => ({ ...prev, [`${wakerId}:${sessionId}`]: stamp }));
  }, []);

  const handleRenameSession = useCallback(
    async (s: SessionView): Promise<void> => {
      const name = window.prompt('会话名称', s.name);
      if (!name?.trim()) return;
      try {
        await renameSession(s.wakerId, s.sessionId, name.trim());
        void refresh();
      } catch {
        /* 忽略 */
      }
    },
    [refresh],
  );

  /** 新建会话：已选中员工就直接建，否则问一下员工 id。 */
  const handleNewSession = useCallback(async (): Promise<void> => {
    const wakerId = selectedWaker ?? window.prompt('员工 id（例如 Public-Opinion）')?.trim();
    if (!wakerId) return;
    try {
      const s = await createSession(wakerId);
      void refresh();
      setChatting({ wakerId, sessionId: s.id });
    } catch {
      /* 忽略 */
    }
  }, [selectedWaker, refresh]);

  /** 清空会话上下文（保留会话本身）：pi 会话文件归档 + 消息计数归零。 */
  const handleClearSession = useCallback(
    async (s: SessionView): Promise<void> => {
      if (!window.confirm(`清空会话「${s.name}」的上下文？会话保留，但${s.wakerName}不再记得之前聊过什么。`)) return;
      try {
        await clearSession(s.wakerId, s.sessionId);
        void refresh();
      } catch (e) {
        setError((e as Error)?.message ?? String(e));
      }
    },
    [refresh],
  );

  const handleDeleteSession = useCallback(
    async (s: SessionView): Promise<void> => {
      if (!window.confirm(`删除会话「${s.name}」？该会话的上下文将不再保留。`)) return;
      try {
        await deleteSession(s.wakerId, s.sessionId);
        void refresh();
      } catch {
        /* 忽略 */
      }
    },
    [refresh],
  );

  /** 删除（归档）员工。纳管自 Pi 的 profile 由后端拒绝，这里只处理本地档案。 */
  const handleDeleteWaker = useCallback(
    async (id: string): Promise<void> => {
      const name = snapshot?.wakers.find((w) => w.id === id)?.name ?? id;
      if (
        !window.confirm(
          `删除员工「${name}」？\n\n档案会移到 data/archived/（可恢复），同时清掉它的渠道配置、头像与会话条目；\n任务流水是账本，会保留。\n\n（纳管自 Pi 的 profile 不受影响，本平台不代为删除）`,
        )
      )
        return;
      try {
        await archiveWaker(id);
        if (selectedWaker === id) setSelectedWaker(null);
        void refresh();
      } catch (e) {
        setError((e as Error)?.message ?? String(e));
      }
    },
    [snapshot, selectedWaker, refresh],
  );

  const selectedWakerName = snapshot?.wakers.find((w) => w.id === selectedWaker)?.name;

  /** 员工 id → 显示名：运行时面板只拿到 id，需要映射成可读名字。 */
  const wakerNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const w of snapshot?.wakers ?? []) m[w.id] = w.name;
    return m;
  }, [snapshot]);

  return (
    <div className="min-h-full">
      <TopBar
        snapshot={snapshot}
        channels={channels}
        query={query}
        onQueryChange={setQuery}
        onRefresh={refresh}
        onTools={() => setToolsOpen(true)}
        onArchitecture={view === 'architecture' ? closeArchitecture : openArchitecture}
        archOpen={view === 'architecture'}
        hasUpdate={hasUpdate}
        loading={loading}
      />

      <main className="flex flex-col gap-3 px-4 pb-8 pt-[68px] md:flex-row">
        <WakerRail
          wakers={snapshot?.wakers ?? []}
          unread={unreadByWaker}
          selected={selectedWaker}
          onSelect={setSelectedWaker}
          onNew={() => setShowNew(true)}
          onImport={() => setShowImport(true)}
          onEdit={setEditing}
          onChat={(id) => setChatting({ wakerId: id })}
          onDelete={(id) => void handleDeleteWaker(id)}
          avatarVersion={avatarVersion}
        />

        {/* 右侧工作区：上方总览 + 使用情况；下方左右分栏 = 对话列表 | 定时任务 */}
        <section className="flex min-w-0 flex-1 flex-col gap-3">
          <OverviewBar snapshot={snapshot} />

          <RuntimePanel runtime={runtime} wakerNames={wakerNames} onChanged={() => void refresh()} />

          {/* 使用统计在左、待办在右，两列等高：待办为空时也不该塌成一条 */}
          {/* [&>*]:min-w-0：热力图这类固定宽度内容不参与收缩，不压住它整行会往右溢出 */}
          <div className="grid items-stretch gap-3 [&>*]:min-w-0 xl:grid-cols-2">
            <UsagePanel usage={usage} wakerName={selectedWakerName} />
            <TodoPanel
              todos={snapshot?.todos ?? []}
              wakers={snapshot?.wakers ?? []}
              defaultWakerId={selectedWaker}
              onChanged={() => void refresh()}
              onOpenSession={(wakerId, sessionId, focusText) => {
                // 跳回留下这条待办的那条对话：顺便标已读，避免它继续挂着红点
                const s = sessions.find((x) => x.wakerId === wakerId && x.sessionId === sessionId);
                if (s) markSeen(s.wakerId, s.sessionId, s.lastActiveAt);
                setChatting({ wakerId, sessionId, focusText });
              }}
            />
          </div>

          {/* 对话列表与定时任务同高：右列用 h-full 跟随左列（列表高度由视口实测） */}
          <div className="grid min-w-0 items-stretch gap-3 lg:grid-cols-2">
            <TaskBoard
              sessions={visible}
              filterKey={`${selectedWaker ?? ''}|${sourceFilter}|${query.trim()}`}
              sourceFilter={sourceFilter}
              onSourceFilter={setSourceFilter}
              unreadKeys={unreadKeys}
              onOpen={(s) => {
                markSeen(s.wakerId, s.sessionId, s.lastActiveAt);
                setChatting({ wakerId: s.wakerId, sessionId: s.sessionId });
              }}
              onRename={(s) => void handleRenameSession(s)}
              onDelete={(s) => void handleDeleteSession(s)}
              onClear={(s) => void handleClearSession(s)}
              onNewSession={() => void handleNewSession()}
              measureKey={`${runtime?.procs.length ?? 0}`}
            />

            <AutomationPanel
              wakers={snapshot?.wakers ?? []}
              automations={automations}
              stats={snapshot?.cronStats}
              onChanged={() => void refresh()}
            />
          </div>
        </section>
      </main>

      {error && (
        <div className="fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded-lg border border-state-bad/40 bg-state-bad/10 px-3 py-2 text-[12px] text-state-bad">
          无法连接网关：{error}（请执行 <code className="font-mono">waker board</code>）
        </div>
      )}

      {showNew && (
        <NewWakerDialog
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            setSelectedWaker(id);
            void refresh();
          }}
        />
      )}

      {showImport && (
        <ImportAgentDialog
          onClose={() => setShowImport(false)}
          onImported={(id) => {
            setShowImport(false);
            setSelectedWaker(id);
            void refresh();
          }}
          // 自动纳管开关会改变整个名册的内容，单独刷新即可，不改选中项
          onConfigSaved={() => void refresh()}
        />
      )}

      {editing && (
        <AgentEditorDialog
          wakerId={editing}
          onSaved={() => void refresh()}
          onClose={() => {
            setEditing(null);
            // 头像可能被换过，递增版本号让看板重新拉图
            setAvatarVersion((v) => v + 1);
            void refresh();
          }}
        />
      )}

      {chatting && (
        <AgentChatDialog
          wakerId={chatting.wakerId}
          wakerName={snapshot?.wakers.find((w) => w.id === chatting.wakerId)?.name ?? chatting.wakerId}
          initialSessionId={chatting.sessionId}
          focusText={chatting.focusText}
          onClose={() => {
            setChatting(null);
            void refresh();
          }}
        />
      )}

      {/* 架构页盖在看板之上：看板的选中项、滚动位置都保留，返回即原样 */}
      {view === 'architecture' && <ArchitecturePage onClose={closeArchitecture} />}

      {toolsOpen && <ToolsDialog onClose={() => setToolsOpen(false)} />}
    </div>
  );
}
