import { useEffect, useState } from 'react';
import {
  Users,
  Plus,
  Terminal,
  MessageSquare,
  MoreHorizontal,
  SlidersHorizontal,
  Trash2,
  Download,
  Globe,
} from 'lucide-react';
import type { WakerSummary } from '../types';
import { avatarUrl, savePermissions } from '../api';

interface Props {
  wakers: WakerSummary[];
  /** 各员工"有新结果未看"的会话数，显示为卡片右下角角标。 */
  unread?: Record<string, number>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  /** 打开「导入本机 agent」弹窗。 */
  onImport: () => void;
  onEdit: (id: string) => void;
  onChat: (id: string) => void;
  onDelete: (id: string) => void;
  /** 改动头像后自增，用于破除图片缓存。 */
  avatarVersion?: number;
}

/** 从员工名取首字作为头像字符，避免依赖图片资源。 */
function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

/** 头像：有自定义图片就显示图片，否则回退到首字。 */
function Avatar({ w, version }: { w: WakerSummary; version?: number }): React.ReactElement {
  const [broken, setBroken] = useState(false);
  const box = `flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md text-[11px] font-semibold ${
    w.enabled ? 'bg-gradient-to-br from-primary to-primary-deep text-white' : 'bg-black/[0.05] text-ink-muted'
  }`;
  if (w.avatar && !broken) {
    return (
      <div className={box}>
        <img
          src={avatarUrl(w.id, version)}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      </div>
    );
  }
  return <div className={box}>{initial(w.name)}</div>;
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition hover:bg-black/[0.05] ${
        danger ? 'text-state-bad' : 'text-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

export default function WakerRail({
  wakers,
  unread,
  selected,
  onSelect,
  onNew,
  onImport,
  onEdit,
  onChat,
  onDelete,
  avatarVersion,
}: Props): React.ReactElement {
  // 当前展开「···」菜单的员工；一次只开一个
  const [menuFor, setMenuFor] = useState<string | null>(null);

  /**
   * 浏览器能力开关。
   *
   * 之前只有「Agent 设置 → 权限」一条路（两层菜单 + 一个页签），实际找不到。
   * 现在卡片上直接有一个地球图标，点一下即切；菜单里也有一项，两处同一份状态。
   *
   * 初值取 snapshot 里的 `w.browser`（一次请求带回来，不给每张卡各发一次）；
   * 切换成功后用本地覆盖，避免等外层刷新才变色。
   */
  const [browserOn, setBrowserOn] = useState<Record<string, boolean>>({});
  const [browserBusy, setBrowserBusy] = useState<string | null>(null);

  const isBrowserOn = (w: WakerSummary): boolean => browserOn[w.id] ?? w.browser === true;

  const toggleBrowser = async (w: WakerSummary): Promise<void> => {
    if (browserBusy === w.id) return;
    setBrowserBusy(w.id);
    try {
      const next = await savePermissions(w.id, { browser: !isBrowserOn(w) });
      setBrowserOn((s) => ({ ...s, [w.id]: next.browser }));
    } catch (e) {
      console.error('[waker] 切换浏览器能力失败:', e);
    } finally {
      setBrowserBusy(null);
    }
  };

  // 点击菜单外任意处收起。用 document 监听而非"全屏遮罩"：
  // 卡片带 hover 位移（transform），会让 fixed 遮罩相对卡片定位而错位。
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent): void => {
      const el = e.target as Element | null;
      if (el?.closest('[data-waker-menu]')) return;
      setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuFor]);

  return (
    <aside className="flex w-full flex-col gap-2.5 md:w-52 md:shrink-0">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          <Users size={12} />
          员工
        </div>
        <span className="font-mono text-[11px] text-ink-muted">{wakers.length}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <button
          onClick={() => onSelect(null)}
          className={`glass glass-hover rounded-lg px-2.5 py-2 text-left ${selected === null ? 'border-primary/50 bg-primary/[0.08]' : ''}`}
        >
          <div className="text-[12px] font-medium text-ink">全部员工</div>
          <div className="text-[10px] text-ink-muted">不按岗位过滤</div>
        </button>

        {wakers.map((w) => {
          const active = selected === w.id;
          const open = menuFor === w.id;
          return (
            // 用 div 作容器：HTML 不允许 button 嵌套 button
            <div
              key={w.id}
              className={`glass glass-hover relative flex items-center gap-0.5 pr-1.5 ${open ? 'z-40' : ''} ${
                active ? 'border-primary/50 bg-primary/[0.08]' : ''
              }`}
            >
              <button
                onClick={() => onSelect(w.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
              >
                <Avatar w={w} version={avatarVersion} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-[12px] font-medium text-ink">{w.name}</span>
                    {w.origin === 'pi' && (
                      <span
                        className="shrink-0 rounded bg-primary/15 px-1 text-[9px] leading-4 text-primary-deep ring-1 ring-primary/30"
                        title="纳管自 Pi 的 agent profile（只读，可在 Pi 侧维护）"
                      >
                        Pi
                      </span>
                    )}
                    {!w.enabled && (
                      <span className="shrink-0 rounded px-1 text-[9px] leading-4 text-ink-muted ring-1 ring-black/[0.08]">
                        停用
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[10px] text-ink-muted" title={w.role}>
                      {w.role}
                    </span>
                    {w.running > 0 && <span className="shrink-0 text-[10px] text-primary">运行中</span>}
                  </div>
                </div>
              </button>

              {w.origin !== 'pi' && (
                <button
                  onClick={() => void toggleBrowser(w)}
                  title={`浏览器能力：${isBrowserOn(w) ? '已开（点击关闭）' : '已关（点击开启）'}`}
                  aria-label={`${w.name} 的浏览器能力`}
                  className={`shrink-0 rounded-md p-1 transition hover:bg-black/[0.05] ${
                    isBrowserOn(w) ? 'text-primary' : 'text-ink-muted/60 hover:text-primary'
                  }`}
                >
                  <Globe size={12} />
                </button>
              )}

              <button
                onClick={() => onChat(w.id)}
                title="和这个员工对话"
                aria-label={`和 ${w.name} 对话`}
                className="shrink-0 rounded-md p-1 text-ink-muted transition hover:bg-black/[0.05] hover:text-primary"
              >
                <MessageSquare size={12} />
              </button>

              <button
                data-waker-menu="trigger"
                onClick={() => setMenuFor(open ? null : w.id)}
                title="更多操作"
                aria-label={`${w.name} 的更多操作`}
                className={`shrink-0 rounded-md p-1 transition hover:bg-black/[0.05] hover:text-primary ${
                  open ? 'bg-black/[0.05] text-primary' : 'text-ink-muted'
                }`}
              >
                <MoreHorizontal size={12} />
              </button>

              {open && (
                <div
                  data-waker-menu="panel"
                  className="glass absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded-lg py-1 shadow-lift"
                >
                    {/* 一个入口：基本信息 / 能力与权限 / 飞书渠道 / 技能 / 头像 / 档案都在同一个弹窗里 */}
                    <MenuItem
                      icon={<SlidersHorizontal size={12} />}
                      label="Agent 设置"
                      onClick={() => {
                        setMenuFor(null);
                        onEdit(w.id);
                      }}
                    />
                    {/* 纳管自 Pi 的 profile 不由本平台删除 */}
                    {w.origin !== 'pi' && (
                      <MenuItem
                        icon={<Trash2 size={12} />}
                        label="删除"
                        danger
                        onClick={() => {
                          setMenuFor(null);
                          onDelete(w.id);
                        }}
                      />
                    )}
                </div>
              )}

              {!!unread?.[w.id] && (
                <span
                  className="absolute -right-1 -top-1 z-10 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-state-bad px-1 text-[9px] font-semibold leading-none text-white"
                  title={`${unread[w.id]} 个会话有新结果`}
                >
                  {unread[w.id]}
                </span>
              )}
            </div>
          );
        })}

        {!wakers.length && (
          <div className="glass rounded-lg px-2.5 py-3 text-[11px] leading-relaxed text-ink-muted">
            还没有员工。在终端创建：
            <code className="mt-1.5 flex items-center gap-1.5 rounded bg-black/[0.05] px-2 py-1 font-mono text-[10px] text-primary">
              <Terminal size={10} /> waker agent new reviewer
            </code>
          </div>
        )}
      </div>

      <div className="mt-0.5 flex flex-col gap-1.5">
        <button
          onClick={onNew}
          className="glass glass-hover flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-left"
        >
          <Plus size={12} className="text-primary" />
          <span className="text-[12px] font-medium text-primary">新建员工</span>
        </button>

        {/* Pi 侧的 agent 默认不再自动出现，改用这个入口逐个收编 */}
        <button
          onClick={onImport}
          className="glass glass-hover flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-left"
        >
          <Download size={12} className="text-ink-muted" />
          <span className="text-[12px] font-medium text-ink-muted">导入本机 agent</span>
        </button>
      </div>
    </aside>
  );
}
