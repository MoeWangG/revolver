import { useEffect, useState } from 'react';
import { X, Download, Check, Bot } from 'lucide-react';
import { fetchConfig, fetchPiAgents, importPiAgent, saveConfig } from '../api';
import type { PiAgentBrief } from '../types';

interface Props {
  onClose: () => void;
  /** 导入成功：外层刷新名册并选中新员工。 */
  onImported: (id: string) => void;
  /** 平台开关变了（名册内容会随之变化）：只刷新，不选中。 */
  onConfigSaved?: () => void;
}

export default function ImportAgentDialog({ onClose, onImported, onConfigSaved }: Props): React.ReactElement {
  const [agents, setAgents] = useState<PiAgentBrief[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [cwd, setCwd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoList, setAutoList] = useState<boolean | null>(null);
  const [savingToggle, setSavingToggle] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchPiAgents(), fetchConfig()])
      .then(([list, cfg]) => {
        if (!alive) return;
        setAgents(list);
        setAutoList(cfg.piAgents);
      })
      .catch((e: unknown) => {
        if (alive) setError((e as Error)?.message ?? String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleAutoList = async (next: boolean): Promise<void> => {
    setSavingToggle(true);
    setError(null);
    try {
      const cfg = await saveConfig({ piAgents: next });
      setAutoList(cfg.piAgents);
      onConfigSaved?.();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setSavingToggle(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!picked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await importPiAgent({ id: picked, cwd: cwd.trim() || undefined });
      onImported(picked);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      setSubmitting(false);
    }
  };

  const selectable = (agents ?? []).filter((a) => !a.imported);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-label="关闭弹窗" />

      <div className="glass relative flex w-full max-w-lg flex-col rounded-2xl p-5">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary-deep">
            <Download size={14} className="text-white" />
          </div>
          <div>
            <div className="text-[15px] font-semibold text-ink">导入本机 agent</div>
            <div className="text-[11px] text-ink-muted">
              把 <code className="font-mono">~/.pi/agent/agents/</code> 里的 agent 收编成平台员工
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg border border-line p-1.5 text-ink-muted transition hover:border-primary/40 hover:text-ink"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {/* 自动纳管开关：默认关。开着的时候名册里会直接混进 Pi 的只读 agent。 */}
        <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-line bg-black/[0.02] px-3 py-2.5">
          <button
            role="switch"
            aria-checked={autoList === true}
            disabled={autoList === null || savingToggle}
            onClick={() => void toggleAutoList(autoList !== true)}
            className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full transition ${
              autoList === true ? 'bg-primary' : 'bg-black/15'
            } ${autoList === null || savingToggle ? 'opacity-50' : ''}`}
          >
            <span
              className={`h-3 w-3 rounded-full bg-white shadow transition ${autoList === true ? 'translate-x-3.5' : 'translate-x-0.5'}`}
            />
          </button>
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-ink">自动纳管本机 agent（只读）</div>
            <div className="text-[11px] leading-relaxed text-ink-muted">
              关（默认）时 Pi 侧的 agent 不出现在名册里，需要哪个就导入哪个——导入后是平台档案，
              能改策略、能收紧权限、能归档。开着则全部直接出现，但只读、不能归档。
            </div>
          </div>
        </div>

        <div className="min-h-[120px] max-h-[260px] overflow-y-auto pr-0.5">
          {agents === null && !error && <div className="px-1 py-6 text-center text-[12px] text-ink-muted">读取中…</div>}

          {agents !== null && !agents.length && (
            <div className="glass rounded-lg px-3 py-4 text-[12px] leading-relaxed text-ink-muted">
              本机没有可导入的 agent（<code className="font-mono">~/.pi/agent/agents/*.md</code> 为空）。
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            {(agents ?? []).map((a) => {
              const on = picked === a.id;
              return (
                <button
                  key={a.id}
                  disabled={a.imported}
                  onClick={() => setPicked(a.id)}
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition ${
                    a.imported
                      ? 'cursor-not-allowed border-line bg-black/[0.02] opacity-55'
                      : on
                        ? 'border-primary/60 bg-primary/[0.06]'
                        : 'border-line bg-black/[0.02] hover:border-primary/40'
                  }`}
                >
                  <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-black/[0.05] text-ink-muted">
                    {a.imported ? <Check size={12} /> : <Bot size={12} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] font-medium text-ink">{a.name}</span>
                      <span className="font-mono text-[10.5px] text-ink-muted">{a.id}</span>
                      {a.imported && <span className="text-[10.5px] text-ink-muted">已导入</span>}
                      {!a.enabled && <span className="text-[10.5px] text-state-warn">已停用</span>}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-ink-muted">{a.role}</div>
                    <div className="mt-1 font-mono text-[10px] text-ink-muted/80">
                      {a.model}
                      {a.tools.length ? ` · ${a.tools.join(',')}` : ''}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <label className="mt-3 flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink">工作目录</span>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="留空 = 平台根目录"
            className="w-full rounded-lg border border-line bg-black/[0.03] px-3 py-2 font-mono text-[12px] text-ink outline-none transition placeholder:text-ink-muted/60 focus:border-primary/50 focus:bg-black/[0.04]"
          />
          <span className="text-[11px] leading-relaxed text-ink-muted">
            该员工的文件操作边界。Pi profile 里没有这个字段，导入时需要定；之后可在档案里改。
          </span>
        </label>

        {error && (
          <div className="mt-3 rounded-lg border border-state-bad/40 bg-state-bad/10 px-3 py-2 text-[12px] text-state-bad">
            {error}
          </div>
        )}

        <div className="mt-5 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-line px-3 py-2 text-[13px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!picked || submitting}
            className="flex-1 rounded-lg bg-primary px-3 py-2 text-[13px] font-medium text-white transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? '导入中…' : picked ? `导入 ${picked}` : '选择要导入的 agent'}
          </button>
        </div>

        {agents !== null && selectable.length === 0 && !!agents.length && (
          <div className="mt-2 text-center text-[11px] text-ink-muted">本机 agent 都已在平台里，没有可导入的了。</div>
        )}
      </div>
    </div>
  );
}
