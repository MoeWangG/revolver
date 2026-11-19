import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, GitCommitHorizontal, Layers, Loader2, RefreshCw } from 'lucide-react';
import { fetchArchitecture } from '../api';
import snapshotJson from '../generated/architecture.json';
import type { ArchitectureView, ReleaseItem } from '../types';
import { formatAgo } from './statusMeta';
import Md from './Md';

interface Props {
  /** 返回看板。 */
  onClose: () => void;
}

/**
 * 构建时烘进 bundle 的快照（`scripts/gen-architecture.ts` 生成）。
 *
 * 为什么页面要自带一份数据：这套东西里，网关是常驻进程（launchd 只在崩溃时拉起），
 * 而前端是从 `web/dist` 直接读的——**重建前端 ≠ 重启网关**。
 * 只依赖 `GET /api/architecture` 的话，升级后打开这一页只会看到报错（旧网关对新路径走 SPA 回退，
 * 回来的是一段 HTML）。所以：先渲染快照，再去问网关要最新的一份；问不到也不影响阅读。
 */
const SNAPSHOT = snapshotJson as unknown as ArchitectureView;

/** 分节配色：新增（绿）/ 变更（主色）/ 修复（黄）/ 其他（灰）。 */
const SECTION_TONE: Record<string, string> = {
  新增: 'text-state-ok',
  变更: 'text-primary',
  修复: 'text-state-warn',
};

/** 按分节归组，并保持文件里的出现顺序（不排序——版本内的顺序是写的人安排的）。 */
function groupBySection(items: ReleaseItem[]): Array<{ key: string; section: string; texts: string[] }> {
  const groups: Array<{ key: string; section: string; texts: string[] }> = [];
  for (const item of items) {
    const section = item.section || '变更';
    const last = groups[groups.length - 1];
    // key 带上位置：同一个分节可能在版本内出现两次（中间夹了别的分节），只用分节名会撞 key
    if (last && last.section === section) last.texts.push(item.text);
    else groups.push({ key: `${groups.length}-${section}`, section, texts: [item.text] });
  }
  return groups;
}

/**
 * 架构与版本页。
 *
 * 存在的理由：这套东西的边界（外壳 / 扩展 / 内核）散在 README、文档和代码注释里，
 * 而"这次升级到底改了什么"原来只能翻 git log。这里把两件事放在同一页：
 * 上面讲**结构**，下面讲**变化**，且都来自服务端与服务端同一份代码
 * （版本读 package.json、记录读 CHANGELOG.md）。
 *
 * 渲染成盖在看板上的整屏层（而不是替换 main），这样看板的选中项与滚动位置都保留，返回即原样；
 * 顶栏 z-30 在它之上，所以入口按钮随时可点回看板。
 */
export default function ArchitecturePage({ onClose }: Props): React.ReactElement {
  const [view, setView] = useState<ArchitectureView>(SNAPSHOT);
  /** 当前显示的是构建快照，还是网关给的最新一份。 */
  const [source, setSource] = useState<'snapshot' | 'server'>('snapshot');
  const [syncing, setSyncing] = useState(false);
  const [syncErr, setSyncErr] = useState<string | null>(null);

  /** 向网关要最新一份；失败就保持快照，不把页面变成错误页。 */
  const sync = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      setView(await fetchArchitecture());
      setSource('server');
      setSyncErr(null);
    } catch (e) {
      setSyncErr((e as Error)?.message ?? String(e));
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void sync();
  }, [sync]);

  // 只在拿到服务端数据后才比对：快照的版本就是构建时的版本，永远相等，比了没意义
  const staleBundle = source === 'server' && view.version !== __APP_VERSION__;

  return (
    <section
      className="fixed inset-0 z-20 overflow-y-auto bg-surface-900/95 backdrop-blur-xl"
      aria-label="架构与版本"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pb-12 pt-[68px]">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-black/[0.03] px-2.5 py-1.5 text-[12px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
          >
            <ArrowLeft size={13} />
            返回看板
          </button>
          <button
            onClick={() => void sync()}
            disabled={syncing}
            title="向网关要一份最新的（读 package.json 与 CHANGELOG.md）"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-black/[0.03] px-2.5 py-1.5 text-[12px] text-ink-muted transition hover:border-primary/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            同步服务端
          </button>
          <span className="ml-auto text-[11px] text-ink-muted">
            {source === 'server' ? `数据生成于 ${formatAgo(view.generatedAt)}` : '来自前端构建时的快照'}
          </span>
        </div>

        {syncErr && (
          <div className="rounded-lg border border-line bg-black/[0.02] px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
            没连上 <code className="font-mono">/api/architecture</code>：{syncErr}。下面显示的是构建时的快照，
            内容与这一版前端一致；重启看板进程后点「同步服务端」即可拿到实时数据。
          </div>
        )}

        {/* 抬头：这是什么、现在是哪一版 */}
        <div className="glass rounded-2xl px-5 py-4">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span className="font-serif text-[20px] font-semibold tracking-tight text-ink">{view.name}</span>
            <span className="rounded border border-line bg-black/[0.04] px-1.5 py-0.5 font-mono text-[11px] leading-none text-ink-muted">
              v{view.version}
            </span>
            <span className="text-[11px] text-ink-muted">当前版本（读 package.json）</span>
          </div>
          {view.description && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">{view.description}</p>
          )}
          {staleBundle && (
            <div className="mt-2.5 rounded-lg border border-state-warn/40 bg-state-warn/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-state-warn">
              服务端是 v{view.version}，前端 bundle 是 v{__APP_VERSION__}——改了代码但没重新构建前端
              （<code className="font-mono">pnpm web:build</code>），页面可能还是旧的。
            </div>
          )}
        </div>

        {/* 结构 */}
        <div className="flex flex-col gap-2.5">
          <h2 className="flex items-center gap-1.5 px-0.5 text-[13px] font-semibold text-ink">
            <Layers size={14} className="text-primary" />
            系统架构
          </h2>
          {view.layers.map((layer, i) => (
            <div key={layer.id} className="glass rounded-xl px-4 py-3.5">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-[10px] text-ink-muted/70">{String(i + 1).padStart(2, '0')}</span>
                <span className="text-[13px] font-medium text-ink">{layer.title}</span>
                <span className="text-[10px] text-ink-muted">{layer.nodes.length} 个模块</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{layer.caption}</p>

              <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                {layer.nodes.map((node) => (
                  <div key={node.name} className="rounded-lg border border-line bg-black/[0.02] px-3 py-2">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[12px] font-medium text-ink">{node.name}</span>
                      {node.path && (
                        <code className="truncate font-mono text-[10px] text-ink-muted/80" title={node.path}>
                          {node.path}
                        </code>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{node.role}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* 变化 */}
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-baseline gap-2 px-0.5">
            <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
              <GitCommitHorizontal size={14} className="text-primary" />
              版本更新记录
            </h2>
            <code className="font-mono text-[10px] text-ink-muted">{view.changelog}</code>
            <span className="ml-auto text-[10px] text-ink-muted">共 {view.releases.length} 个版本</span>
          </div>

          {!view.changelogFound ? (
            <div className="rounded-xl border border-line bg-black/[0.02] px-4 py-6 text-center text-[12px] text-ink-muted">
              仓库里没有 <code className="font-mono">{view.changelog}</code>。发版时在仓库根新建它
              （格式见文件顶部说明），这一页就会自动列出各版本改了什么。
            </div>
          ) : !view.releases.length ? (
            <div className="rounded-xl border border-line bg-black/[0.02] px-4 py-6 text-center text-[12px] text-ink-muted">
              {view.changelog} 里还没有任何版本段。
            </div>
          ) : (
            view.releases.map((rel) => {
              const current = rel.version === view.version;
              return (
                <div
                  key={`${rel.version}-${rel.date ?? ''}`}
                  className={`glass rounded-xl px-4 py-3.5 ${current ? 'ring-1 ring-primary/30' : ''}`}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-[13px] font-semibold text-ink">v{rel.version}</span>
                    {rel.date && <span className="text-[11px] text-ink-muted">{rel.date}</span>}
                    {current && (
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        本版变更
                      </span>
                    )}
                  </div>

                  {rel.items.length ? (
                    <div className="mt-2 flex flex-col gap-2">
                      {groupBySection(rel.items).map((g) => (
                        <div key={g.key}>
                          <div className={`text-[10px] font-medium ${SECTION_TONE[g.section] ?? 'text-ink-muted'}`}>
                            {g.section}
                          </div>
                          {g.section === '验收' ? (
                            // 验收条目里是 `![说明](/verify/x.png)`：整块按 Markdown 渲染，
                            // 图片宽度收在容器内。普通条目仍走上面的列表样式，避免每条都带图。
                            <div className="mt-1 flex flex-col gap-2">
                              {g.texts.map((t, i) => (
                                <div
                                  key={i}
                                  className="overflow-hidden rounded-lg border border-line bg-black/[0.02] p-2 [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-line [&_p]:m-0 [&_p]:text-[11px] [&_p]:leading-relaxed [&_p]:text-ink-muted"
                                >
                                  <Md text={t} />
                                </div>
                              ))}
                            </div>
                          ) : (
                            <ul className="mt-1 flex flex-col gap-1">
                              {g.texts.map((t, i) => (
                                <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-ink-muted">
                                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-muted/40" />
                                  <span className="min-w-0">{t}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1.5 text-[11px] text-ink-muted">（这一版没有条目）</div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {syncing && (
          <div className="flex items-center justify-center gap-2 py-2 text-[11px] text-ink-muted">
            <Loader2 size={12} className="animate-spin" /> 正在向网关同步…
          </div>
        )}
      </div>
    </section>
  );
}
