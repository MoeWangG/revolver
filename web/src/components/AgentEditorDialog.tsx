import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Save,
  FileText,
  Loader2,
  Sparkles,
  UserRound,
  Upload,
  Trash2,
  IdCard,
  ShieldCheck,
  Plus,
  Radio,
} from 'lucide-react';
import {
  fetchAgentFiles,
  saveAgentFile,
  fetchAgentSkills,
  saveAgentSkills,
  fetchProfile,
  saveProfile,
  fetchPermissions,
  savePermissions,
  avatarUrl,
  saveAvatar,
  deleteAvatar,
} from '../api';
import type { SkillInfo } from '../api';
import type { AgentFileView, AgentPermissions, WakerProfile } from '../types';
import ChannelPanel from './ChannelPanel';

/** 每个文件的用途说明，编辑时直接告诉使用者该写什么。 */
const FILE_HINTS: Record<string, { title: string; hint: string }> = {
  'SOUL.md': {
    title: '人设总纲',
    hint: '最稳定的部分：不随任务变化的判断倾向、说话方式、底线。装配时排在最前。',
  },
  'identity.md': {
    title: '职责范围',
    hint: '我是谁、服务对象是谁、主要职责有哪些。决定它接什么活、不接什么活。',
  },
  'persona.md': {
    title: '工作风格',
    hint: '先分析还是先动手、结论怎么组织、输出什么格式。',
  },
  'bible.md': {
    title: '红线与边界',
    hint: '禁止做什么、什么必须先人工确认。与机器强制的策略互相印证。',
  },
  'MEMORY.md': {
    title: '长期记忆',
    hint: '跨任务仍有效的约定。纳入 git 版本化，可回滚。',
  },
};

/** 左侧列表里的"基本信息"伪文件名（名称 / 岗位 / 模型）。 */
const PROFILE_TAB = '__profile__';

/** 左侧列表里的"技能"伪文件名。 */
const SKILLS_TAB = '__skills__';

/** 左侧列表里的"头像"伪文件名。 */
const AVATAR_TAB = '__avatar__';

/** 左侧列表里的"权限"伪文件名。 */
const PERMS_TAB = '__permissions__';

/** 左侧列表里的"飞书渠道"伪文件名（内容由 ChannelPanel 提供）。 */
const CHANNEL_TAB = '__channel__';

/** 权限页的编辑状态：两个目录清单 + 两个能力开关。 */
interface PermForm {
  pathAllow: string[];
  pathDeny: string[];
  selfEdit: boolean;
  browser: boolean;
}

/** 空白新增条目时的提示语。 */
const EMPTY_NOTE: Record<'pathAllow' | 'pathDeny', string> = {
  pathAllow: '当前不限制：它可读写整个文件系统（只受下面的保护名单约束）。',
  pathDeny: '当前没有额外保护：.ssh / .env 这类凭据也会被放行。',
};

/** 头像边长（px）。够清晰，又能让请求体保持很小。 */
const AVATAR_SIZE = 256;

/**
 * 把用户选的图片**居中裁成方形并等比缩放**后转成 PNG data URL。
 * 在前端做这件事：后端只需落盘一种格式，也不会把用户的大原图存下来。
 */
async function toSquarePng(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolvePromise, rejectPromise) => {
    const fr = new FileReader();
    fr.onload = () => resolvePromise(String(fr.result));
    fr.onerror = () => rejectPromise(new Error('读取图片失败'));
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolvePromise, rejectPromise) => {
    const el = new Image();
    el.onload = () => resolvePromise(el);
    el.onerror = () => rejectPromise(new Error('不是有效的图片文件'));
    el.src = dataUrl;
  });
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持图片处理');
  const side = Math.min(w, h);
  ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return canvas.toDataURL('image/png');
}

/**
 * 字符串清单编辑器（目录白名单 / 保护名单共用）。
 *
 * 不用飞书渠道那套"逗号分隔的输入框"：这两处装的是**路径**，
 * 路径里出现空格、逗号都不奇怪；而且写错一条就得整行重打，改一条等于重写全清单。
 * 做成 chip 后单条增删，出错只动一条。
 */
function ListEditor(props: {
  items: string[];
  emptyNote: string;
  placeholder: string;
  disabled?: boolean;
  onAdd: (v: string) => void;
  onRemove: (i: number) => void;
}): React.ReactElement {
  const [input, setInput] = useState('');
  const add = (): void => {
    const v = input.trim();
    if (!v) return;
    props.onAdd(v);
    setInput('');
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {props.items.map((it, i) => (
          <span
            key={`${it}-${i}`}
            className="flex items-center gap-1 rounded-lg border border-line bg-black/[0.04] px-2 py-1 font-mono text-[11px] text-ink"
          >
            {it}
            {!props.disabled && (
              <button
                onClick={() => props.onRemove(i)}
                className="text-ink-muted transition hover:text-state-bad"
                aria-label={`移除 ${it}`}
              >
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        {!props.items.length && <span className="text-[11px] text-state-warn">{props.emptyNote}</span>}
      </div>
      {!props.disabled && (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder={props.placeholder}
            className="min-w-0 flex-1 rounded-lg border border-line bg-black/[0.03] px-2.5 py-1.5 font-mono text-[11px] text-ink outline-none transition focus:border-primary/50"
          />
          <button
            onClick={add}
            disabled={!input.trim()}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-ink-muted transition hover:border-primary/40 hover:text-ink disabled:opacity-40"
          >
            <Plus size={11} />
            添加
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  wakerId: string;
  onClose: () => void;
  /** 名称/岗位改动后回调，让外层刷新看板。 */
  onSaved?: () => void;
}

export default function AgentEditorDialog({ wakerId, onClose, onSaved }: Props): React.ReactElement {
  const [files, setFiles] = useState<AgentFileView[] | null>(null);
  // 打开即落在「基本信息」——改名是最常见的诉求
  const [active, setActive] = useState<string>(PROFILE_TAB);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 技能勾选
  const [skillAll, setSkillAll] = useState<SkillInfo[]>([]);
  const [skillOn, setSkillOn] = useState<Set<string>>(new Set());
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillMsg, setSkillMsg] = useState<string | null>(null);

  // 头像
  const [hasAvatar, setHasAvatar] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState<string | null>(null);
  /** 上传/清除后自增，让 <img> 重新加载。 */
  const [avatarNonce, setAvatarNonce] = useState(0);

  // 基本信息（名称 / 岗位 / 模型）
  const [profile, setProfile] = useState<WakerProfile | null>(null);
  const [form, setForm] = useState<{ name: string; role: string; model: string; cwd: string }>({
    name: '',
    role: '',
    model: '',
    cwd: '',
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);

  // 权限（目录范围 + 档案自改）
  const [perms, setPerms] = useState<AgentPermissions | null>(null);
  const [permForm, setPermForm] = useState<PermForm>({ pathAllow: [], pathDeny: [], selfEdit: false, browser: false });
  const [permSaving, setPermSaving] = useState(false);
  const [permMsg, setPermMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // 用 ref 持有最新 draft，让键盘快捷键回调不必反复重建
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    fetchAgentFiles(wakerId)
      .then((list) => {
        setFiles(list);
        setDraft(Object.fromEntries(list.map((f) => [f.name, f.content])));
        setActive((cur) => {
          // 伪页签（基本信息 / 技能 / 头像 / 权限）不属于档案文件列表，
          // 不能被"回退到第一个文件"的逻辑切走——否则打开就看不到基本信息
          if (
            cur === PROFILE_TAB ||
            cur === SKILLS_TAB ||
            cur === AVATAR_TAB ||
            cur === PERMS_TAB ||
            cur === CHANNEL_TAB
          ) {
            return cur;
          }
          return list.some((f) => f.name === cur) ? cur : (list[0]?.name ?? 'SOUL.md');
        });
        setLoadError(null);
      })
      .catch((e) => setLoadError((e as Error)?.message ?? String(e)));

    fetchAgentSkills(wakerId)
      .then((s) => {
        setSkillAll(s.all);
        // 未配置时按"全部生效"回显，保存后变为显式清单
        setSkillOn(new Set(s.enabled ?? s.all.map((x) => x.name)));
      })
      .catch(() => {
        /* 技能加载失败不影响档案编辑 */
      });
  }, [wakerId]);

  const save = useCallback(async (): Promise<void> => {
    const content = draftRef.current[active];
    if (content == null || saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveAgentFile(wakerId, active, content);
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }, [active, saving, wakerId]);

  const saveSkills = useCallback(async (): Promise<void> => {
    setSkillSaving(true);
    setSkillMsg(null);
    try {
      await saveAgentSkills(wakerId, [...skillOn]);
      setSkillMsg('已保存，下次对话生效');
    } catch (e) {
      setSkillMsg((e as Error)?.message ?? '保存失败');
    } finally {
      setSkillSaving(false);
    }
  }, [wakerId, skillOn]);

  // 载入基本信息
  useEffect(() => {
    let alive = true;
    fetchProfile(wakerId)
      .then((p) => {
        if (!alive) return;
        setProfile(p);
        setForm({ name: p.name, role: p.role, model: p.model, cwd: p.cwd });
      })
      .catch((e) => {
        if (alive) setLoadError((e as Error)?.message ?? String(e));
      });
    return () => {
      alive = false;
    };
  }, [wakerId]);

  // 载入权限（生效值：后端 registry 解析后的结果，不是 yaml 原文）
  useEffect(() => {
    let alive = true;
    fetchPermissions(wakerId)
      .then((p) => {
        if (!alive) return;
        setPerms(p);
        setPermForm({ pathAllow: p.pathAllow, pathDeny: p.pathDeny, selfEdit: p.selfEdit, browser: p.browser });
      })
      .catch((e) => {
        if (alive) setLoadError((e as Error)?.message ?? String(e));
      });
    return () => {
      alive = false;
    };
  }, [wakerId]);

  const saveProfileForm = useCallback(async (): Promise<void> => {
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      const next = await saveProfile(wakerId, {
        name: form.name.trim(),
        role: form.role.trim(),
        model: form.model.trim(),
        // 只在真的变了才提交：后端对 cwd 做了"必须绝对路径 + 目录必须存在"的校验，
        // 原样回传也能过，但没必要让每次保存都去动这个键。
        ...(form.cwd.trim() !== profile?.cwd ? { cwd: form.cwd.trim() } : {}),
      });
      setProfile(next);
      setForm({ name: next.name, role: next.role, model: next.model, cwd: next.cwd });
      // 后端会在换了工作目录时带回一条提醒（会话按目录存放这件事必须说清楚）
      setProfileMsg(next.warnings?.length ? next.warnings.join(' / ') : '已保存');
      onSaved?.();
    } catch (e) {
      setProfileMsg((e as Error)?.message ?? '保存失败');
    } finally {
      setProfileSaving(false);
    }
  }, [wakerId, form, onSaved]);

  const profileDirty =
    profile != null &&
    (form.name !== profile.name ||
      form.role !== profile.role ||
      form.model !== profile.model ||
      form.cwd !== profile.cwd);

  const savePerms = useCallback(async (): Promise<void> => {
    if (!perms) return;
    setPermSaving(true);
    setPermMsg(null);
    try {
      // 只提交真的变了的项：pathAllow 有"空 = 不限制"的语义，
      // 每次都回传会让"没配"变成"显式配成空"，虽然等效但会把文件越改越脏。
      const patch: { pathAllow?: string[]; pathDeny?: string[]; selfEdit?: boolean; browser?: boolean } = {};
      if (JSON.stringify(permForm.pathAllow) !== JSON.stringify(perms.pathAllow)) patch.pathAllow = permForm.pathAllow;
      if (JSON.stringify(permForm.pathDeny) !== JSON.stringify(perms.pathDeny)) patch.pathDeny = permForm.pathDeny;
      if (permForm.selfEdit !== perms.selfEdit) patch.selfEdit = permForm.selfEdit;
      if (permForm.browser !== perms.browser) patch.browser = permForm.browser;

      const next = await savePermissions(wakerId, patch);
      setPerms(next);
      setPermForm({ pathAllow: next.pathAllow, pathDeny: next.pathDeny, selfEdit: next.selfEdit, browser: next.browser });
      setPermMsg({
        text: next.warnings?.length ? next.warnings.join(' ') : '已保存并重新编译，下一个任务/下一轮对话生效',
        ok: true,
      });
      onSaved?.();
    } catch (e) {
      // 失败必须与成功区分颜色：这条位置就在成功提示下面，同色会让人以为存上了
      setPermMsg({ text: (e as Error)?.message ?? '保存失败', ok: false });
    } finally {
      setPermSaving(false);
    }
  }, [wakerId, perms, permForm, onSaved]);

  const permDirty =
    perms != null &&
    (JSON.stringify(permForm.pathAllow) !== JSON.stringify(perms.pathAllow) ||
      JSON.stringify(permForm.pathDeny) !== JSON.stringify(perms.pathDeny) ||
      permForm.selfEdit !== perms.selfEdit ||
      permForm.browser !== perms.browser);

  // 探测是否已有头像（GET 成功即有）
  useEffect(() => {
    let alive = true;
    void fetch(avatarUrl(wakerId), { method: 'GET' })
      .then((r) => {
        if (alive) setHasAvatar(r.ok);
      })
      .catch(() => {
        /* 探测失败按无头像处理 */
      });
    return () => {
      alive = false;
    };
  }, [wakerId, avatarNonce]);

  const pickAvatar = useCallback(
    async (file: File): Promise<void> => {
      setAvatarBusy(true);
      setAvatarMsg(null);
      try {
        const png = await toSquarePng(file);
        await saveAvatar(wakerId, png);
        setHasAvatar(true);
        setAvatarNonce((n) => n + 1);
        setAvatarMsg('头像已保存');
      } catch (e) {
        setAvatarMsg((e as Error)?.message ?? '上传失败');
      } finally {
        setAvatarBusy(false);
      }
    },
    [wakerId],
  );

  const clearAvatar = useCallback(async (): Promise<void> => {
    setAvatarBusy(true);
    setAvatarMsg(null);
    try {
      await deleteAvatar(wakerId);
      setHasAvatar(false);
      setAvatarNonce((n) => n + 1);
      setAvatarMsg('头像已清除');
    } catch (e) {
      setAvatarMsg((e as Error)?.message ?? '清除失败');
    } finally {
      setAvatarBusy(false);
    }
  }, [wakerId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (active === PROFILE_TAB) void saveProfileForm();
        else if (active === SKILLS_TAB) void saveSkills();
        else if (active === PERMS_TAB) void savePerms();
        else if (active === CHANNEL_TAB) {
          /* 飞书面板自带保存按钮：它还要 reloadChannels，走自己的流程 */
        } else if (active !== AVATAR_TAB) void save();
      }
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, saveSkills, saveProfileForm, savePerms, active, onClose]);

  const isProfile = active === PROFILE_TAB;
  const isSkills = active === SKILLS_TAB;
  const isAvatar = active === AVATAR_TAB;
  const isPerms = active === PERMS_TAB;
  const isChannel = active === CHANNEL_TAB;
  const current = files?.find((f) => f.name === active);
  const value = draft[active] ?? '';
  const dirty = current != null && value !== current.content;

  const tabClass = (on: boolean): string =>
    `rounded-lg px-2.5 py-2 text-left transition ${on ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-black/[0.03]'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={onClose} aria-label="关闭编辑器" />

      <div className="glass relative flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <FileText size={15} className="text-primary" />
          <div>
            <div className="text-[14px] font-semibold text-ink">编辑 · {wakerId}</div>
            <div className="text-[11px] text-ink-muted">保存后立即重新编译，下次对话即生效</div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg border border-line p-1.5 text-ink-muted transition hover:border-primary/40 hover:text-ink"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>

        {loadError && (
          <div className="mx-4 mt-3 rounded-lg border border-state-bad/40 bg-state-bad/10 px-3 py-2 text-[12px] text-state-bad">
            加载失败：{loadError}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line p-3">
            {/* 三块：设置（身份/能力/渠道）· 运行（技能/头像）· 档案（人设正文） */}
            <div className="px-1.5 pb-1 pt-1 text-[10px] font-medium tracking-wide text-ink-muted/70">设置</div>
            <button onClick={() => setActive(PROFILE_TAB)} className={tabClass(isProfile)}>
              <div className="flex items-center gap-1.5">
                <IdCard size={12} className="text-primary" />
                <span className="text-[12px] font-medium text-ink">基本信息</span>
              </div>
              <code className="text-[10px] text-ink-muted">{profile?.name ?? '…'}</code>
            </button>

            <div className="px-1.5 pb-1 pt-2 text-[10px] font-medium tracking-wide text-ink-muted/70">运行</div>
            <button onClick={() => setActive(SKILLS_TAB)} className={tabClass(isSkills)}>
              <div className="flex items-center gap-1.5">
                <Sparkles size={12} className="text-primary" />
                <span className="text-[12px] font-medium text-ink">技能</span>
              </div>
              <code className="text-[10px] text-ink-muted">
                {skillOn.size}/{skillAll.length} 已勾选
              </code>
            </button>

            <button onClick={() => setActive(AVATAR_TAB)} className={tabClass(isAvatar)}>
              <div className="flex items-center gap-1.5">
                <UserRound size={12} className="text-primary" />
                <span className="text-[12px] font-medium text-ink">头像</span>
              </div>
              <code className="text-[10px] text-ink-muted">{hasAvatar ? '已设置' : '未设置'}</code>
            </button>

            <button onClick={() => setActive(PERMS_TAB)} className={tabClass(isPerms)}>
              <div className="flex items-center gap-1.5">
                <ShieldCheck size={12} className="text-primary" />
                <span className="text-[12px] font-medium text-ink">能力与权限</span>
              </div>
              <code className="text-[10px] text-ink-muted">
                {perms == null
                  ? '…'
                  : `${perms.pathAllow.length || '不限'}${perms.selfEdit ? ' · 自改开' : ''}${perms.browser ? ' · 浏览器开' : ''}`}
              </code>
            </button>

            <button onClick={() => setActive(CHANNEL_TAB)} className={tabClass(isChannel)}>
              <div className="flex items-center gap-1.5">
                <Radio size={12} className="text-primary" />
                <span className="text-[12px] font-medium text-ink">飞书渠道</span>
              </div>
              <code className="text-[10px] text-ink-muted">App ID / 白名单</code>
            </button>

            <div className="px-1.5 pb-1 pt-2 text-[10px] font-medium tracking-wide text-ink-muted/70">档案</div>
            {(files ?? []).map((f) => {
              const meta = FILE_HINTS[f.name] ?? { title: f.name, hint: '' };
              const isDirty = (draft[f.name] ?? '') !== f.content;
              return (
                <button key={f.name} onClick={() => setActive(f.name)} className={tabClass(active === f.name)}>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium text-ink">{meta.title}</span>
                    {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-state-warn" />}
                  </div>
                  <code className="text-[10px] text-ink-muted">{f.name}</code>
                </button>
              );
            })}
          </div>

          <div className="flex min-w-0 flex-1 flex-col p-3">
            {isProfile ? (
              <>
                <div className="mb-2 text-[11px] leading-relaxed text-ink-muted">
                  名称会显示在看板卡片与会话列表里；岗位描述帮助它判断该接什么活。
                  {profile?.origin === 'pi' && ' 该员工纳管自 Pi 的 profile，此处只读，请到 Pi 侧修改。'}
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  {(
                    [
                      { key: 'name' as const, label: '名称', hint: '看板卡片与会话列表里显示的名字' },
                      { key: 'role' as const, label: '岗位', hint: '一句话说清它负责什么' },
                      { key: 'model' as const, label: '模型', hint: '如 deepseek-v4-pro；auto 表示跟随 pi 默认' },
                    ]
                  ).map((f) => (
                    <label key={f.key} className="flex flex-col gap-1">
                      <span className="text-[12px] font-medium text-ink">{f.label}</span>
                      <input
                        value={form[f.key]}
                        onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                        disabled={profile?.origin === 'pi'}
                        className="rounded-lg border border-line bg-black/[0.03] px-3 py-2 text-[13px] text-ink outline-none transition focus:border-primary/50 disabled:opacity-60"
                      />
                      <span className="text-[10px] text-ink-muted">{f.hint}</span>
                    </label>
                  ))}
                  <div className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-ink">工作目录</span>
                    <input
                      value={form.cwd}
                      onChange={(e) => setForm((prev) => ({ ...prev, cwd: e.target.value }))}
                      disabled={profile?.origin === 'pi'}
                      placeholder="/Users/you/workspace"
                      className="rounded-lg border border-line bg-black/[0.03] px-3 py-2 font-mono text-[12px] text-ink outline-none transition focus:border-primary/50 disabled:opacity-60"
                    />
                    <span className="text-[10px] leading-relaxed text-ink-muted">
                      它是这个员工的文件系统边界（也是 pi 子进程的 spawn 目录）。
                      <br />
                      必须是已存在的<b className="text-state-warn">绝对路径</b>。
                      <br />
                      <span className="text-state-warn">
                        改动副作用：pi 的会话按目录存放，换目录后历史会话仍留在旧目录（不会丢，但会话列表会变短）
                      </span>
                      ；若 waker.yaml 配了 policy.pathAllow，记得确认它仍覆盖新目录。
                    </span>
                  </div>
                </div>
              </>
            ) : isAvatar ? (
              <>
                <div className="mb-2 text-[11px] leading-relaxed text-ink-muted">
                  上传一张头像，看板左侧的员工卡片会显示它。图片会自动裁成方形并缩放到 {AVATAR_SIZE}×{AVATAR_SIZE}
                  ，上传即生效。
                </div>
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-line bg-black/[0.02]">
                  <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-xl border border-line bg-black/[0.04]">
                    {hasAvatar ? (
                      <img
                        src={avatarUrl(wakerId, avatarNonce)}
                        alt="头像预览"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <UserRound size={32} className="text-ink-muted" />
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-primary-deep">
                      {avatarBusy ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                      上传图片
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) void pickAvatar(f);
                        }}
                      />
                    </label>
                    {hasAvatar && (
                      <button
                        onClick={() => void clearAvatar()}
                        disabled={avatarBusy}
                        className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-ink-muted transition hover:border-state-bad/40 hover:text-state-bad disabled:opacity-40"
                      >
                        <Trash2 size={12} />
                        清除
                      </button>
                    )}
                  </div>
                  <div className="text-[11px] text-ink-muted">
                    {avatarMsg ?? '支持 PNG / JPEG / WebP，建议使用方形图'}
                  </div>
                </div>
              </>
            ) : isPerms ? (
              <>
                <div className="mb-2 text-[11px] leading-relaxed text-ink-muted">
                  这里改的是 <code>waker.yaml</code> 的 <code>policy</code> 段，保存后立即重新编译。
                  <b className="text-ink">它不是给模型的建议，而是执行时真的会被拦</b>（waker-guard 在工具调用层判定）。
                  {perms?.editable === false && ' 该员工纳管自 Pi 的 profile，此处只读。'}
                </div>
                {perms ? (
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
                    <div className="rounded-lg border border-line p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-[12px] font-medium text-ink">可读写目录</span>
                        <code className="text-[10px] text-ink-muted">policy.pathAllow</code>
                        <button
                          onClick={() =>
                            setPermForm((p) =>
                              p.pathAllow.includes(perms.cwd) ? p : { ...p, pathAllow: [...p.pathAllow, perms.cwd] },
                            )
                          }
                          disabled={perms.editable === false || permForm.pathAllow.includes(perms.cwd)}
                          className="ml-auto rounded-lg border border-line px-2 py-1 text-[10px] text-ink-muted transition hover:border-primary/40 hover:text-ink disabled:opacity-40"
                        >
                          加上工作目录
                        </button>
                      </div>
                      <ListEditor
                        items={permForm.pathAllow}
                        emptyNote={EMPTY_NOTE.pathAllow}
                        placeholder="/Users/you/Documents/工作目录（必须绝对路径）"
                        disabled={perms.editable === false}
                        onAdd={(v) =>
                          setPermForm((p) => (p.pathAllow.includes(v) ? p : { ...p, pathAllow: [...p.pathAllow, v] }))
                        }
                        onRemove={(i) => setPermForm((p) => ({ ...p, pathAllow: p.pathAllow.filter((_, k) => k !== i) }))}
                      />
                      <div className="mt-2 text-[10px] leading-relaxed text-ink-muted">
                        读 / 写 / 编辑 / ls / grep / find 都按这个范围判定（相对路径按工作目录解析）。
                        <br />
                        <span className="text-state-warn">
                          注意：bash 命令里的路径不受这份清单约束
                        </span>
                        ——只有命令白名单与保护名单管得住它；要连位置一起管，得开 sandbox。
                      </div>
                    </div>

                    <div className="rounded-lg border border-line p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-[12px] font-medium text-ink">保护名单</span>
                        <code className="text-[10px] text-ink-muted">policy.pathDeny</code>
                      </div>
                      <ListEditor
                        items={permForm.pathDeny}
                        emptyNote={EMPTY_NOTE.pathDeny}
                        placeholder=".ssh / .env / secrets.json（片段即可）"
                        disabled={perms.editable === false}
                        onAdd={(v) =>
                          setPermForm((p) => (p.pathDeny.includes(v) ? p : { ...p, pathDeny: [...p.pathDeny, v] }))
                        }
                        onRemove={(i) => setPermForm((p) => ({ ...p, pathDeny: p.pathDeny.filter((_, k) => k !== i) }))}
                      />
                      <div className="mt-2 text-[10px] leading-relaxed text-ink-muted">
                        写片段、不写整路径（用包含匹配）：命中即拦，read 与 bash 都管。
                      </div>
                    </div>

                    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        checked={permForm.selfEdit}
                        disabled={perms.editable === false}
                        onChange={(e) => setPermForm((p) => ({ ...p, selfEdit: e.target.checked }))}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-medium text-ink">允许它修改自己的档案</span>
                          <code className="text-[10px] text-ink-muted">policy.selfEdit</code>
                        </div>
                        <div className="mt-1 text-[10px] leading-relaxed text-ink-muted">
                          开启后它拿到 <code>waker_self_edit</code> 工具，可改自己的 SOUL / 身份 / 风格 / 红线 / 长期记忆。
                          <br />
                          · 写前自动备份到 <code>data/identity-history/</code>，每次修改留痕到 <code>data/selfedit.jsonl</code>；
                          <br />
                          · <b className="text-ink">改不了 waker.yaml</b> —— 权限不在可改之列，它无法给自己扩权；
                          <br />
                          · 改动<b className="text-ink">下一次对话生效</b>（身份在启动时装载）。
                        </div>
                      </div>
                    </label>

                    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        checked={permForm.browser}
                        disabled={perms.editable === false}
                        onChange={(e) => setPermForm((p) => ({ ...p, browser: e.target.checked }))}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-medium text-ink">允许它操作浏览器</span>
                          <code className="text-[10px] text-ink-muted">policy.browser</code>
                        </div>
                        <div className="mt-1 text-[10px] leading-relaxed text-ink-muted">
                          开启后它拿到 <code>browser</code> 工具（一条多行命令 DSL：goto / snapshot / click / fill…），
                          操作的是 Chrome 里扩展
                          <b className="text-ink">当前所连的那个标签页</b>（复用真实登录态，不是无头浏览器）。
                          <br />
                          · 前提：broker 在跑（<code>waker browser start</code>，首次调用也会自动拉起）且扩展已启用
                          （2.x 连常驻 daemon，不用点 Connect），否则调用会明确报错；
                          <br />
                          · 浏览器是<b className="text-ink">单标签页</b>：多个任务同时用会排队，队列满直接拒绝；
                          <br />
                          · 页面操作<b className="text-ink">不可逆</b>（误点删除 / 发布），建议保留 requireConfirm 的"发布 / 对外发送"。
                        </div>
                      </div>
                    </label>
                  </div>
                ) : (
                  <div className="flex flex-1 items-center justify-center text-[12px] text-ink-muted">
                    <Loader2 size={14} className="mr-2 animate-spin" />
                    载入中…
                  </div>
                )}
                {permMsg && (
                  <div
                    className={`mt-2 shrink-0 text-[11px] leading-relaxed ${permMsg.ok ? 'text-state-ok' : 'text-state-bad'}`}
                  >
                    {permMsg.text}
                  </div>
                )}
              </>
            ) : isChannel ? (
              <ChannelPanel wakerId={wakerId} />
            ) : isSkills ? (
              <>
                <div className="mb-2 text-[11px] leading-relaxed text-ink-muted">
                  勾选这个员工用得上的技能。只加载勾选的（未勾选的不加载），避免无关技能干扰它的判断。
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line">
                  {skillAll.map((s) => (
                    <label
                      key={s.name}
                      title={s.description || s.name}
                      className="flex cursor-pointer items-start gap-2 border-b border-line px-3 py-2 text-[12px] text-ink last:border-b-0 hover:bg-black/[0.02]"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        checked={skillOn.has(s.name)}
                        onChange={(e) =>
                          setSkillOn((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(s.name);
                            else next.delete(s.name);
                            return next;
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono">{s.name}</div>
                        {s.description && (
                          <div className="mt-0.5 line-clamp-1 text-[10px] leading-relaxed text-ink-muted">
                            {s.description}
                          </div>
                        )}
                      </div>
                    </label>
                  ))}
                  {!skillAll.length && (
                    <div className="px-3 py-6 text-center text-[12px] text-ink-muted">没有发现技能</div>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-3 text-[11px] text-ink-muted">
                  <span>已勾选 {skillOn.size} 个</span>
                  {skillMsg && <span className="text-state-ok">{skillMsg}</span>}
                  <span className="ml-auto">⌘S 保存 · Esc 关闭</span>
                </div>
              </>
            ) : current ? (
              <>
                <div className="mb-2 text-[11px] leading-relaxed text-ink-muted">{FILE_HINTS[active]?.hint}</div>
                <textarea
                  value={value}
                  onChange={(e) => setDraft((d) => ({ ...d, [active]: e.target.value }))}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none rounded-lg border border-line bg-black/[0.03] p-3 font-mono text-[12px] leading-relaxed text-ink outline-none transition focus:border-primary/50"
                />
                <div className="mt-2 flex items-center gap-3 text-[11px] text-ink-muted">
                  <span>{value.length} 字符</span>
                  {dirty && <span className="text-state-warn">有未保存改动</span>}
                  {!dirty && savedAt && <span className="text-state-ok">已保存并重新编译</span>}
                  <span className="ml-auto">⌘S 保存 · Esc 关闭</span>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[12px] text-ink-muted">
                <Loader2 size={14} className="mr-2 animate-spin" />
                载入中…
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="mx-4 mb-2 rounded-lg border border-state-bad/40 bg-state-bad/10 px-3 py-2 text-[12px] text-state-bad">
            {error}
          </div>
        )}

        <div className="flex gap-2 border-t border-line px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-2 text-[13px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
          >
            关闭
          </button>
          {isProfile ? (
            <>
              {profileMsg && <span className="self-center text-[11px] text-state-ok">{profileMsg}</span>}
              <button
                onClick={() => void saveProfileForm()}
                disabled={!profileDirty || profileSaving || profile?.origin === 'pi'}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
              >
                {profileSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                保存
              </button>
            </>
          ) : isAvatar ? (
            <span className="ml-auto self-center text-[11px] text-ink-muted">头像上传后即时生效，无需保存</span>
          ) : isSkills ? (
            <button
              onClick={saveSkills}
              disabled={skillSaving}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {skillSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              保存技能
            </button>
          ) : isChannel ? (
            <span className="ml-auto self-center text-[11px] text-ink-muted">保存后立即重载渠道</span>
          ) : isPerms ? (
            <button
              onClick={() => void savePerms()}
              disabled={!permDirty || permSaving || perms?.editable === false}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {permSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              保存权限
            </button>
          ) : (
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              保存
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
