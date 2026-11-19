import { useEffect, useState } from 'react';
import { Cpu, Hourglass, Square } from 'lucide-react';
import type { ProcView, RuntimeView } from '../types';
import { cancelTask } from '../api';
import { formatDuration, sourceMeta } from './statusMeta';

interface Props {
  runtime: RuntimeView | null;
  /** 员工 id → 显示名。 */
  wakerNames: Record<string, string>;
  /** 终止后回调，由外层刷新看板。 */
  onChanged: () => void;
}

/**
 * 运行时：此刻有哪些 pi 子进程在跑、跑了多久、正在输出什么。
 *
 * 与"任务流水"的区别：流水是事后账本（跑完才知道结果），
 * 这里回答的是"现在正在发生什么"——对齐 Pie 的运行时输出视图。
 * 输出尾部来自子进程 stdout/stderr，服务端只保留最近一段，不落盘。
 */
export default function RuntimePanel({ runtime, wakerNames, onChanged }: Props): React.ReactElement | null {
  const procs = runtime?.procs ?? [];
  const queued = runtime?.queue?.queued ?? [];
  // 轮询是 5 秒一次，耗时在两次之间自己走，避免看起来卡住
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!procs.length) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [procs.length]);

  if (!procs.length && !queued.length) return null;

  const skew = runtime ? Date.now() - new Date(runtime.generatedAt).getTime() : 0;

  const onCancel = (taskId: string, wakerId: string): void => {
    if (!window.confirm(`终止 ${wakerNames[wakerId] ?? wakerId} 的任务？已产生的文件变更不会撤销。`)) return;
    void cancelTask(taskId).then(onChanged).catch(() => undefined);
  };

  return (
    <section className="glass rounded-xl px-3.5 py-3">
      <header className="flex flex-wrap items-center gap-2">
        <Cpu size={13} className="text-primary" />
        <span className="text-[13px] font-medium text-ink">运行时</span>
        <span className="text-[11px] text-ink-muted">
          {procs.length} 个进程执行中
          {queued.length ? ` · ${queued.length} 个排队` : ''}
          {runtime?.queue ? `（上限 ${runtime.queue.maxPerWaker}/员工、${runtime.queue.maxTotal} 总数）` : ''}
        </span>
        <span className="ml-auto font-mono text-[10px] text-ink-muted">
          常驻 {formatDuration((runtime?.uptime ?? 0) * 1000)} · {runtime?.memoryMb ?? 0} MB
        </span>
      </header>

      <div className="mt-2.5 flex flex-col gap-2">
        {procs.map((p) => {
          const src = sourceMeta(p.source);
          return (
            <div key={p.taskId} className="rounded-lg border border-line bg-black/[0.02] px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full bg-primary ${p.cancelling ? '' : 'animate-pulse'}`} />
                <span className="text-[12px] font-medium text-ink">{wakerNames[p.wakerId] ?? p.wakerId}</span>
                <span className={`rounded px-1.5 py-[1px] text-[10px] ring-1 ring-inset ${src.chip}`}>{src.label}</span>
                {p.pid && <span className="font-mono text-[10px] text-ink-muted">pid {p.pid}</span>}
                <span className="ml-auto font-mono text-[11px] text-ink">{formatDuration(p.elapsedMs + skew)}</span>
                <button
                  type="button"
                  onClick={() => onCancel(p.taskId, p.wakerId)}
                  disabled={p.cancelling}
                  title="终止该任务"
                  className="flex items-center gap-1 rounded-md border border-line px-1.5 py-[2px] text-[10px] text-ink-muted transition hover:border-state-bad/40 hover:text-state-bad disabled:opacity-50"
                >
                  <Square size={9} />
                  {p.cancelling ? '终止中' : '终止'}
                </button>
              </div>

              <div className="mt-1 truncate text-[11px] text-ink-muted" title={p.prompt}>
                {p.prompt}
              </div>

              {p.tail && (
                <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.04] px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-muted">
                  {p.tail}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {queued.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
          <span className="text-[10px] text-ink-muted">
            排队中（同一会话串行；超过每员工 {runtime?.queue?.maxPerWaker ?? 3} 个、全局{' '}
            {runtime?.queue?.maxTotal ?? 6} 个上限时排队）
          </span>
          {queued.map((q) => (
            <div key={q.taskId} className="flex items-center gap-2 text-[11px] text-ink-muted">
              <Hourglass size={10} />
              <span>{wakerNames[q.wakerId] ?? q.wakerId}</span>
              <span className="font-mono text-[10px]">{q.key}</span>
              <button
                type="button"
                onClick={() => onCancel(q.taskId, q.wakerId)}
                className="ml-auto rounded-md border border-line px-1.5 py-[1px] text-[10px] transition hover:border-state-bad/40 hover:text-state-bad"
              >
                取消排队
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="mt-2 text-[10px] text-ink-muted">
        仅显示看板进程拉起的执行；CLI（<code className="font-mono">waker say</code> / <code className="font-mono">run</code>）是独立进程，不在其中。
      </p>
    </section>
  );
}
