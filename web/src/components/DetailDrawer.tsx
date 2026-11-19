import { X, RotateCw, FileText, ShieldAlert, Clock, Timer, Ban } from 'lucide-react';
import type { TaskRecord } from '../types';
import { statusMeta, sourceMeta, formatDuration, formatClock } from './statusMeta';
import Md from './Md';

interface Props {
  task: TaskRecord;
  onClose: () => void;
  onRerun: (task: TaskRecord) => void;
  onCancel: (task: TaskRecord) => void;
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex gap-2.5 py-2">
      <span className="mt-0.5 text-ink-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wider text-ink-muted">{label}</div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-ink">{children}</div>
      </div>
    </div>
  );
}

export default function DetailDrawer({ task, onClose, onRerun, onCancel }: Props): React.ReactElement {
  const st = statusMeta(task.status);
  const src = sourceMeta(task.source);

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md animate-slide-in flex-col border-l border-line bg-surface-900/95 backdrop-blur-2xl">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className={`rounded px-1.5 py-px text-[10px] ring-1 ${src.chip}`}>{src.label}</span>
        <span className={`rounded px-1.5 py-px text-[10px] ring-1 ${st.chip}`}>{st.label}</span>
        <span className="font-mono text-[11px] text-ink-muted">{task.wakerId}</span>
        <button
          onClick={onClose}
          className="ml-auto rounded-lg border border-line p-1.5 text-ink-muted transition hover:border-primary/40 hover:text-ink"
          aria-label="关闭"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <Row icon={<FileText size={13} />} label="实际输入">
          <div className="whitespace-pre-wrap break-words">{task.prompt}</div>
        </Row>

        <Row icon={<Timer size={13} />} label="耗时">
          <span className="font-mono">
            {formatDuration(task.durationMs)}（{formatClock(task.startedAt)} → {formatClock(task.endedAt)}）
          </span>
        </Row>

        {!!task.blockedCount && (
          <Row icon={<ShieldAlert size={13} />} label="门禁拦截">
            <span className="text-state-warn">本次执行被策略拦截 {task.blockedCount} 次</span>
          </Row>
        )}

        {task.error && (
          <Row icon={<Ban size={13} />} label="错误">
            <span className="whitespace-pre-wrap break-words text-state-bad">{task.error}</span>
          </Row>
        )}

        {task.result && (
          <Row icon={<FileText size={13} />} label="最终产出">
            {/* 员工产出是 Markdown（标题/列表/表格/代码块），按渲染后的样子看才是它真正的交付形态 */}
            <div className="max-h-72 overflow-auto rounded-lg border border-line bg-black/[0.03] p-2.5">
              <Md text={task.result} className="text-[12px] leading-relaxed text-ink" />
            </div>
          </Row>
        )}

        {task.sessionRef && (
          <Row icon={<Clock size={13} />} label="会话回溯">
            <code className="block break-all font-mono text-[11px] text-primary">{task.sessionRef}</code>
          </Row>
        )}

        <Row icon={<Clock size={13} />} label="任务 ID">
          <code className="break-all font-mono text-[11px] text-ink-muted">{task.taskId}</code>
        </Row>
      </div>

      <div className="flex gap-2 border-t border-line px-4 py-3">
        <button
          onClick={() => onRerun(task)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-white transition hover:bg-primary-deep"
        >
          <RotateCw size={13} />
          重跑
        </button>
        {(task.status === 'running' || task.status === 'queued') && (
          <button
            onClick={() => onCancel(task)}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-state-bad/40 px-3 py-2 text-[13px] text-state-bad transition hover:bg-state-bad/10"
          >
            <Ban size={13} />
            终止
          </button>
        )}
      </div>
    </div>
  );
}
