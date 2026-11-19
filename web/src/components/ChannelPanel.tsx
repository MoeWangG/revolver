/**
 * 飞书渠道配置面板（**无弹窗外壳**）。
 *
 * 背景：这套配置原来是独立弹窗 `ChannelDialog`，入口挂在名册卡片的「⋯」里，
 * 与「Agent 设置」并列——同一个员工的配置被拆成两个入口，实际用起来是"找半天"。
 * 现在它是「Agent 设置」弹窗里的一块（页签：飞书渠道），配合同一个页面的
 * 基本信息 / 能力与权限 / 技能 / 头像 / 档案，一屏之内改完这个员工的一切。
 *
 * 保存语义与原来一致：落盘 `data/channels/<id>.json`，然后 `reloadChannels()`
 * 让渠道立即生效（不用重启看板）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Save, Loader2, Info } from 'lucide-react';
import { fetchChannelConfig, saveChannelConfig, reloadChannels } from '../api';

interface Props {
  wakerId: string;
}

/** 把逗号/空格/分号分隔的输入解析成去重后的数组。 */
function parseList(s: string): string[] {
  return [...new Set(s.split(/[\s,，;；]+/).map((x) => x.trim()).filter(Boolean))];
}

export default function ChannelPanel({ wakerId }: Props): React.ReactElement {
  const [enabled, setEnabled] = useState(false);
  const [agent, setAgent] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [allowAllUsers, setAllowAllUsers] = useState(false);
  const [allowAllChats, setAllowAllChats] = useState(false);
  const [users, setUsers] = useState('');
  const [chats, setChats] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchChannelConfig(wakerId)
      .then((c) => {
        const f = c.feishu;
        setEnabled(f?.enabled ?? false);
        setAgent(f?.agent ?? '');
        setAppId(f?.appId ?? '');
        setAllowAllUsers(f?.allowAllUsers ?? false);
        setAllowAllChats(f?.allowAllChats ?? false);
        setUsers((f?.allowedUsers ?? []).join(', '));
        setChats((f?.allowedChats ?? []).join(', '));
        setHasSecret(c.hasAppSecret);
      })
      .catch((e) => setErr((e as Error)?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [wakerId]);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await saveChannelConfig(
        wakerId,
        {
          enabled,
          agent: agent.trim() || undefined,
          appId: appId.trim() || undefined,
          allowAllUsers,
          allowAllChats,
          allowedUsers: parseList(users),
          allowedChats: parseList(chats),
        },
        appSecret.trim() ? appSecret.trim() : undefined,
      );
      if (appSecret.trim()) setHasSecret(true);
      setAppSecret('');
      const list = await reloadChannels();
      const mine = list.find((c) => c.wakerId === wakerId);
      setMsg(mine ? `已保存并应用：${mine.name} → ${mine.state}${mine.error ? `（${mine.error}）` : ''}` : '已保存');
    } catch (e) {
      setErr((e as Error)?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [wakerId, enabled, agent, appId, appSecret, allowAllUsers, allowAllChats, users, chats]);

  const input =
    'w-full rounded-lg border border-line bg-black/[0.03] px-3 py-2 text-[13px] text-ink outline-none transition placeholder:text-ink-muted/60 focus:border-primary/50';

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ink-muted">
        <Loader2 size={14} className="animate-spin" /> 载入中…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 text-[11px] leading-relaxed text-ink-muted">
        这套飞书应用只服务这个员工。保存后自动重载渠道，**不用重启看板**。
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pr-1">
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="accent-primary"
          />
          启用这个飞书渠道
        </label>

        <div className="rounded-lg border border-line bg-black/[0.02] px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
          发给这个机器人的消息，交给**本员工**处理。若想让机器人服务另一个员工，把渠道配到那个员工上。
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink">App ID</span>
          <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxxxxxxx" className={input} />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-ink">App Secret</span>
          <input
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={hasSecret ? '已配置，留空表示不修改' : '请输入 App Secret'}
            className={input}
          />
        </label>

        <div className="rounded-lg border border-line bg-black/[0.02] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-ink">
            <Info size={12} className="text-ink-muted" /> 响应范围
          </div>
          <label className="flex items-center gap-2 py-1 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={allowAllUsers}
              onChange={(e) => setAllowAllUsers(e.target.checked)}
              className="accent-primary"
            />
            允许直接回复所有私聊
          </label>
          <label className="flex items-center gap-2 py-1 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={allowAllChats}
              onChange={(e) => setAllowAllChats(e.target.checked)}
              className="accent-primary"
            />
            允许直接回复所有群消息（无需 @ 白名单）
          </label>
          <div className="mt-2 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] text-ink-muted">额外允许的私聊 open_id（逗号分隔）</span>
              <input value={users} onChange={(e) => setUsers(e.target.value)} placeholder="ou_xxx, ou_yyy" className={input} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] text-ink-muted">额外允许的群 chat_id（逗号分隔）</span>
              <input value={chats} onChange={(e) => setChats(e.target.value)} placeholder="oc_xxx, oc_yyy" className={input} />
            </label>
          </div>
          <div className="mt-2 text-[11px] leading-relaxed text-ink-muted">
            群消息要能被收到，还需在飞书开放平台给该应用开启「接收群聊中所有消息」并发布生效；默认机器人只收到 @ 它的消息。
          </div>
        </div>

        {err && (
          <div className="rounded-lg border border-state-bad/40 bg-state-bad/10 px-3 py-2 text-[12px] text-state-bad">{err}</div>
        )}
        {msg && (
          <div className="rounded-lg border border-state-ok/40 bg-state-ok/10 px-3 py-2 text-[12px] text-state-ok">{msg}</div>
        )}
      </div>

      <div className="mt-3 flex shrink-0 items-center gap-2 border-t border-line pt-3">
        <span className="text-[11px] text-ink-muted">保存后会立即重载渠道，无需重启看板</span>
        <button
          onClick={() => void save()}
          disabled={busy}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          保存并应用
        </button>
      </div>
    </div>
  );
}
