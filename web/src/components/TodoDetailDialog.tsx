import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, MessagesSquare, Timer, Trash2, User, X } from 'lucide-react';
import type { TodoView } from '../types';
import { fetchTask } from '../api';
import { PHASE_CHIP, PHASE_LABEL, SOURCE_LABEL, fmtFull, relDue, todoPhaseOf } from './todoMeta';

interface Props {
  todo: TodoView;
  /** 当前时间戳：到期 / 过期是派生的，详情也要跟着时间走。 */
  now: number;
  nameOf: (wakerId: string) => string;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onDone: (note: string) => void;
  onDismiss: () => void;
  onSnooze: () => void;
  /**
   * 有来源会话时才提供。
   * `focusText` 是留下这条待办时用户的原话——聊天窗据此**滚到并高亮具体那一条**。
   */
  onOpenSession?: (focusText?: string) => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-ink-muted">{label}</span>
      <span className="text-[12px] text-ink">{children}</span>
    </div>
  );
}

/**
 * 待办详情：**卡片上只能放两行摘要**，全文与出处都在这里。
 *
 * 两个必须有的能力：
 *  1. 详情与结果**不截断**（列表里的 line-clamp 是给列表用的）；
 *  2. 能跳回留下它的那条对话——待办只有一句话，真正的上下文在会话里。
 */
export default function TodoDetailDialog({
  todo,
  now,
  nameOf,
  busy,
  error,
  onClose,
  onDone,
  onDismiss,
  onSnooze,
  onOpenSession,
}: Props): React.ReactElement {
  const [note, setNote] = useState(todo.note ?? '');
  const [jumping, setJumping] = useState(false);
  const phase = todoPhaseOf(todo, now);
  const canAct = todo.status === 'pending';

  /** 先反查「留下它时用户说了什么」，再把那句话交给聊天窗去定位。 */
  const openSource = async (): Promise<void> => {
    setJumping(true);
    let text: string | undefined;
    if (todo.sourceTaskId) {
      try {
        text = (await fetchTask(todo.sourceTaskId)).prompt;
      } catch {
        /* 任务流水查不到就退回"只打开会话"，不阻断跳转 */
      }
    }
    setJumping(false);
    onOpenSession?.(text);
  };

  // Esc 关闭：详情是浮层，键盘用户不该被迫去找关闭按钮
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 必须挂到 body：TodoPanel 的 `.glass` 用了 backdrop-filter，会形成 stacking context，
  // 留在里面 z-50 也压不住后面的面板（实测按钮点不到）。
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="my-auto w-full max-w-2xl rounded-xl border border-line bg-surface-800 p-4 shadow-lift"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`待办详情：${todo.title}`}
      >
        <header className="flex items-start gap-2">
          <span className={`mt-0.5 shrink-0 rounded px-1.5 py-px text-[10px] ring-1 ${PHASE_CHIP[phase]}`}>
            {PHASE_LABEL[phase]}
          </span>
          <h3 className="min-w-0 flex-1 text-[15px] font-medium leading-snug text-ink">{todo.title}</h3>
          <button
            onClick={onClose}
            aria-label="关闭详情"
            className="shrink-0 rounded p-1 text-ink-muted transition hover:text-ink"
          >
            <X size={14} />
          </button>
        </header>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line bg-black/[0.02] px-3 py-2 sm:grid-cols-4">
          <Row label="谁来处理">
            <span className="flex items-center gap-1">
              {todo.assignee === 'agent' ? <Bot size={11} className="text-primary" /> : <User size={11} className="text-ink-muted" />}
              {todo.assignee === 'agent' ? '机器人' : '真人'}
              <span className="text-ink-muted">@{nameOf(todo.wakerId)}</span>
            </span>
          </Row>
          <Row label="截止">
            <span className="font-mono text-[11px]">{fmtFull(todo.dueAt)}</span>
            <span className="ml-1 text-[10px] text-ink-muted">{relDue(todo.dueAt, now)}</span>
          </Row>
          <Row label="来源">{SOURCE_LABEL[todo.source] ?? todo.source}</Row>
          <Row label="创建">
            <span className="font-mono text-[11px]">{fmtFull(todo.createdAt)}</span>
          </Row>
        </div>

        <section className="mt-3">
          <h4 className="text-[11px] font-medium text-ink-muted">详情</h4>
          {todo.detail ? (
            <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink">{todo.detail}</p>
          ) : (
            <p className="mt-1 text-[12px] text-ink-muted">（这条待办没有补充说明）</p>
          )}
        </section>

        {todo.result && (
          <section className="mt-3">
            <h4 className="text-[11px] font-medium text-ink-muted">执行结果</h4>
            <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink">{todo.result}</p>
          </section>
        )}

        {todo.error && (
          <section className="mt-3">
            <h4 className="text-[11px] font-medium text-state-bad">失败原因</h4>
            <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-state-bad">{todo.error}</p>
          </section>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-muted">
          {todo.doneAt && <span>处理于 {fmtFull(todo.doneAt)}</span>}
          {todo.snoozedCount ? <span>已顺延 {todo.snoozedCount} 次</span> : null}
          {todo.sessionId && <span className="font-mono">会话 {todo.sessionId}</span>}
        </div>

        {canAct && (
          <label className="mt-3 flex flex-col gap-1">
            <span className="text-[11px] text-ink-muted">结束时的备注（可留空）</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="做完了，结果如何？"
              className="resize-none rounded-md border border-line bg-black/[0.02] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-primary/50"
            />
          </label>
        )}

        {error && <p className="mt-2 text-[11px] text-state-bad">{error}</p>}

        <footer className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
          {onOpenSession && (
            <button
              onClick={() => void openSource()}
              disabled={jumping}
              className="flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-[12px] text-primary ring-1 ring-primary/25 transition hover:bg-primary/15 disabled:opacity-50"
            >
              <MessagesSquare size={12} />
              {jumping ? '定位中…' : '定位到来源消息'}
            </button>
          )}
          {canAct && (
            <>
              <button
                disabled={busy}
                onClick={() => onDone(note)}
                className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[12px] text-white transition hover:bg-primary-deep disabled:opacity-40"
              >
                <Check size={12} />
                结束
              </button>
              <button
                disabled={busy}
                onClick={onSnooze}
                className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-muted transition hover:border-primary/40 hover:text-ink disabled:opacity-40"
              >
                <Timer size={12} />
                顺延 1 天
              </button>
              <button
                disabled={busy}
                onClick={onDismiss}
                className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-muted transition hover:border-state-bad/40 hover:text-state-bad disabled:opacity-40"
              >
                <Trash2 size={12} />
                关闭（不做了）
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded-md px-2.5 py-1 text-[12px] text-ink-muted transition hover:text-ink"
          >
            关闭窗口
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
