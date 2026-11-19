import { useState } from 'react';
import { X, UserPlus } from 'lucide-react';
import { createWaker } from '../api';

interface Props {
  onClose: () => void;
  onCreated: (id: string) => void;
  /** 默认工作目录，取自首个已有员工，方便保持一致。 */
  defaultCwd?: string;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-relaxed text-ink-muted">{hint}</span>}
    </label>
  );
}

export default function NewWakerDialog({ onClose, onCreated, defaultCwd }: Props): React.ReactElement {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 与后端 safeId 保持一致：只允许安全字符，避免路径穿越
  const idValid = /^[a-zA-Z0-9._-]+$/.test(id.trim());
  const canSubmit = idValid && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await createWaker({
        id: id.trim(),
        name: name.trim() || undefined,
        role: role.trim() || undefined,
        cwd: cwd.trim() || undefined,
      });
      onCreated(id.trim());
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-label="关闭弹窗"
      />

      <div className="glass relative w-full max-w-md rounded-2xl p-5">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary-deep">
            <UserPlus size={14} className="text-white" />
          </div>
          <div>
            <div className="text-[15px] font-semibold text-ink">新建员工</div>
            <div className="text-[11px] text-ink-muted">创建后立即编译，可以马上对话</div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg border border-line p-1.5 text-ink-muted transition hover:border-primary/40 hover:text-ink"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-3.5">
          <Field label="员工 ID" hint="只能包含字母、数字、点、下划线和连字符，将作为目录名">
            <input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="例如：opsbot"
              autoFocus
              className={`w-full rounded-lg border bg-black/[0.03] px-3 py-2 text-[13px] text-ink outline-none transition placeholder:text-ink-muted/60 focus:bg-black/[0.04] ${
                id && !idValid ? 'border-state-bad/60' : 'border-line focus:border-primary/50'
              }`}
            />
          </Field>

          <Field label="岗位描述" hint="写清它负责什么。留空则生成占位档案，需要之后手动补全">
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="例如：每日巡检项目变更并生成简报"
              className="w-full rounded-lg border border-line bg-black/[0.03] px-3 py-2 text-[13px] text-ink outline-none transition placeholder:text-ink-muted/60 focus:border-primary/50 focus:bg-black/[0.04]"
            />
          </Field>

          <Field label="显示名" hint="留空则使用 ID">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：运维巡检"
              className="w-full rounded-lg border border-line bg-black/[0.03] px-3 py-2 text-[13px] text-ink outline-none transition placeholder:text-ink-muted/60 focus:border-primary/50 focus:bg-black/[0.04]"
            />
          </Field>

          <Field label="工作目录" hint="该员工的文件操作边界。留空则使用服务端当前目录">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/you/project"
              className="w-full rounded-lg border border-line bg-black/[0.03] px-3 py-2 font-mono text-[12px] text-ink outline-none transition placeholder:text-ink-muted/60 focus:border-primary/50 focus:bg-black/[0.04]"
            />
          </Field>

          {error && (
            <div className="rounded-lg border border-state-bad/40 bg-state-bad/10 px-3 py-2 text-[12px] text-state-bad">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-line px-3 py-2 text-[13px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="flex-1 rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-white transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
