import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  X,
  Send,
  MessageSquare,
  Loader2,
  ShieldAlert,
  History,
  Coins,
  Wrench,
  Brain,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  Quote,
  Scissors,
  Paperclip,
  FileText,
} from 'lucide-react';
import {
  talkAgent,
  createSession,
  fetchSessions,
  fetchSessionMessages,
  fetchSessionUsage,
  sessionImageUrl,
  suggestTopic,
  uploadAttachment,
} from '../api';
import { formatDateTime } from './statusMeta';
import { fmtTokens, fmtCost } from '../format';
import Md from './Md';
import { composeQuoted, parseQuoted, quoteSource, type QuoteMode, type QuoteRef } from '../quote';
import type { ChatImage, ChatStep } from '../api';
import type { SessionMeta, SessionUsage } from '../types';

interface Props {
  wakerId: string;
  wakerName: string;
  /** 打开时定位到的会话（从看板会话列表点进来时用）。 */
  initialSessionId?: string;
  /**
   * 打开时要定位的那句原话（从待办「定位到来源消息」进来时用）。
   * 只给会话 id 不够：一个会话几十条消息，得滚到留下待办的那一条。
   */
  focusText?: string;
  onClose: () => void;
}

/**
 * 执行过程（思考 + 工具调用）：**默认收起**，点标题展开看**完整**内容。
 * 折叠态在标题右侧给一句概览（工具名 × 次数 / 思考次数），收起也不丢信息。
 */
function StepsBlock({ steps }: { steps: ChatStep[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const tools = steps.filter((s) => s.kind === 'tool');
  const thinkCount = steps.length - tools.length;
  const names = [...new Set(tools.map((s) => s.name ?? 'tool'))];
  const overview = [
    ...names.map((n) => {
      const c = tools.filter((s) => (s.name ?? 'tool') === n).length;
      return c > 1 ? `${n}×${c}` : n;
    }),
    ...(thinkCount ? [`思考×${thinkCount}`] : []),
  ].join(' · ');

  return (
    <div className="mb-1.5 w-full overflow-hidden rounded-lg border border-line bg-black/[0.02]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-ink-muted transition hover:bg-black/[0.04]"
      >
        {open ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
        <span className="shrink-0 text-primary/80">执行过程</span>
        <span className="shrink-0 font-mono">{steps.length} 步</span>
        {!open && !!overview && <span className="min-w-0 truncate font-mono">{overview}</span>}
        <span className="ml-auto shrink-0 text-[10px]">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        // 整个展开区也限高：单块限 15 行后，11 步仍可能叠成长条；超出在**这个区域**滚，
        // 不把对话窗（和背后的看板）挤满。
        <div className="max-h-[52vh] space-y-2 overflow-y-auto border-t border-line px-2.5 py-2">
          {steps.map((s, i) => (
            <div key={i}>
              <div className="mb-1 flex items-center gap-1.5 text-[10px] text-ink-muted">
                {s.kind === 'thinking' ? (
                  <Brain size={10} className="text-primary/70" />
                ) : (
                  <Wrench size={10} className="text-primary/70" />
                )}
                <span className="font-mono">{s.kind === 'thinking' ? '思考' : (s.name ?? 'tool')}</span>
              </div>
              {/* 完整内容：不截断；默认展示 15 行，超出块内滚动（.step-scroll），信息不丢 */}
              <pre className="step-scroll overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.03] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-muted">
                {s.detail || s.summary}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 单文件上限与单次附件数：与 `core/attachments.ts` 保持一致（前端不复用服务端代码）。 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 6;

/** 交给 `/api/talk` 的附件：`name` 是原始文件名，会话文本里那行 `【附件：…】` 用它。 */
interface TalkAttachment {
  id: string;
  name: string;
}

/**
 * 待发送的附件。**点发送时才上传**：用户可以先看预览、删掉传错的，
 * 不至于一点错就白传一遍几十 MB。
 */
interface PendingFile {
  key: string;
  file: File;
  /** 本地 blob URL，只用于缩略图；移除时必须 revoke，否则会攒一堆几十 MB 的 blob。 */
  previewUrl?: string;
  kind: 'image' | 'document' | 'other';
}

interface Msg {
  role: 'user' | 'agent' | 'system';
  text: string;
  /** 消息时间（ISO8601）。 */
  at: string;
  /** 执行步骤（工具调用等），展示在正文之前的引用块里。 */
  steps?: ChatStep[];
  /** 历史消息附的图片（服务端只给行号+序号，图片本体按需回取）。 */
  images?: ChatImage[];
  /**
   * **刚发出去**那条消息的附件预览：图片带本地 blob URL（立刻可见），
   * 文档只有文件名。刷新后由历史里的 `images` 接管。
   */
  localAttachments?: Array<{ name: string; url?: string }>;
  /** 上下文压缩节点：对话在此处被压缩过，**记录完整保留**。 */
  compaction?: { tokensBefore: number; summaryChars: number };
}

/**
 * 对话窗：**从右侧滑出的侧栏**，不遮挡整屏，看板仍可操作。
 * 内容只负责"这个会话里说什么"；会话的切换 / 新建 / 改名 / 删除都在看板主列表完成。
 */
export default function AgentChatDialog({
  wakerId,
  wakerName,
  initialSessionId,
  focusText,
  onClose,
}: Props): React.ReactElement {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState('');
  /**
   * 待确认的话题建议。存在它就意味着：这条消息**还一个字都没写进任何会话**。
   * 判定在发送前做，所以不会出现"两个会话各留一份"。
   *
   * 两种形态对应飞书那两种询问：
   *  - `switch`：切回某个旧话题（有 target，带会话卡摘要）；
   *  - `new`：开一个新话题（没有 target，接受后先建会话）。
   */
  const [suggestion, setSuggestion] = useState<{
    mode: 'switch' | 'new';
    payload: string;
    /** 附件必须跟着建议一起存：用户点了"切过去"之后才真正发送。 */
    attachments: TalkAttachment[];
    targetId?: string;
    targetTitle?: string;
    recap?: string;
    similarity?: number;
    /** new 模式下用：当前话题叫什么，正文里要说"前面在聊《X》"。 */
    currentTitle?: string;
  } | null>(null);
  /** 正在等话题判定。判定要上百毫秒到 1 秒多，不给提示会像"按了没反应"。 */
  const [judging, setJudging] = useState(false);
  /** 接受建议后的一行落地状态：`已切到《X》，正在回答…` → `已处理完成`。 */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  /**
   * 刚发生过会话切换。
   *
   * 为什么要有：切过去之后头部那行「话题：X」变化很不起眼（尤其两边标题都长），
   * 实测用户会以为"点了没反应"。这里让头部**亮 4 秒**，再在消息流里插一条
   * 本地系统行说明"从哪切到哪"——两处都说，才不容易被漏看。
   */
  const [justSwitched, setJustSwitched] = useState(false);
  const switchTimer = useRef<number | null>(null);
  const [msgsBySession, setMsgsBySession] = useState<Record<string, Msg[]>>({});
  const [histLoading, setHistLoading] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  /** 待发送附件；真正的上传发生在按下发送之后。 */
  const [pending, setPending] = useState<PendingFile[]>([]);
  /** 附件相关的可读提示（超限、上传失败）。不做无声跳过。 */
  const [attachError, setAttachError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  /** 加入待发送附件。超限与超量都给可读提示，不静默丢掉。 */
  const addFiles = useCallback((files: File[]): void => {
    if (!files.length) return;
    // 用 Set 收集提示：React 严格模式下 updater 可能被执行两次，数组会重复
    const rejected = new Set<string>();
    setPending((prev) => {
      const next = [...prev];
      for (const file of files) {
        if (next.length >= MAX_FILES) {
          rejected.add(`一次最多 ${MAX_FILES} 个附件`);
          break;
        }
        if (file.size > MAX_FILE_BYTES) {
          rejected.add(`「${file.name}」超过 20MB`);
          continue;
        }
        const isImage = file.type.startsWith('image/');
        next.push({
          key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          kind: isImage ? 'image' : 'other',
          previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        });
      }
      return next;
    });
    setAttachError([...rejected].join('；'));
  }, []);

  const removeFile = useCallback((key: string): void => {
    setPending((prev) => {
      const hit = prev.find((p) => p.key === key);
      if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }, []);


  /**
   * 显示一行状态。
   *
   * `autoClear=false` 由调用方自己收尾（"正在回答…" → "已处理完成"），
   * 因为这两步之间隔着模型那几十秒，定时清掉会让人以为白等了。
   */
  const flashNotice = useCallback((text: string | null, autoClear = true): void => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = null;
    setNotice(text);
    if (text && autoClear) {
      noticeTimer.current = window.setTimeout(() => setNotice(null), 2500);
    }
  }, []);

  // 关窗时把待清的定时器一起收掉，避免对已卸载组件 setState
  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      if (switchTimer.current) window.clearTimeout(switchTimer.current);
    },
    [],
  );

  /** 草稿按「员工:会话」存在本地：关掉对话窗再打开，没发出去的内容还在。 */
  const draftKey = `waker.draft.${wakerId}:${activeId}`;

  const writeDraft = useCallback(
    (v: string): void => {
      setInput(v);
      try {
        if (v) localStorage.setItem(draftKey, v);
        else localStorage.removeItem(draftKey);
      } catch {
        /* 存储不可用时忽略 */
      }
    },
    [draftKey],
  );

  // 切换会话时换成该会话的草稿（在当前会话打字不会串到别的会话里去）
  useEffect(() => {
    if (!activeId) return;
    try {
      setInput(localStorage.getItem(draftKey) ?? '');
    } catch {
      setInput('');
    }
  }, [draftKey, activeId]);

  const messages = msgsBySession[activeId] ?? [];
  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  /** 本会话用量（token / 费用），展示在底部状态行。 */
  const [usage, setUsage] = useState<SessionUsage | null>(null);

  /**
   * 待发送的引用（点气泡上的「回复 / 引用」设置）。
   * 发送时拼进文本一起交给 `/api/talk`——**拼装只有 web/src/quote.ts 一份实现**，
   * 于是任务流水与会话文件里记录的就是模型真正收到的（含引用来源），刷新后还能渲染回引用块。
   */
  const [quote, setQuote] = useState<{ ref: QuoteRef; mode: QuoteMode } | null>(null);

  const pickQuote = useCallback((m: Msg, mode: QuoteMode): void => {
    const ref = quoteSource(m);
    if (ref) setQuote({ ref, mode });
  }, []);

  const loadUsage = useCallback((): void => {
    if (!activeId) return;
    fetchSessionUsage(wakerId, activeId)
      .then(setUsage)
      .catch(() => setUsage(null));
  }, [wakerId, activeId]);

  // 打开 / 切换会话时取一次
  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  // 定位会话：优先用传入的会话，否则默认会话，再否则第一个
  useEffect(() => {
    let cancelled = false;
    fetchSessions(wakerId)
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        const pick =
          (initialSessionId && list.find((s) => s.id === initialSessionId)?.id) ||
          list.find((s) => s.id === 'default')?.id ||
          list[0]?.id ||
          '';
        setActiveId(pick);
      })
      .catch(() => {
        /* 拉不到就空着 */
      });
    return () => {
      cancelled = true;
    };
  }, [wakerId, initialSessionId]);

  /**
   * 已经拉过历史的会话。**不能用"本地有消息"来判断**：
   * 从建议卡片跳到目标会话时，我们会先把这条新消息塞进本地列表，
   * 旧实现看到"已有内容"就跳过拉取，于是跳过去只看到这一条、历史全空白（实测 bug）。
   */
  const loadedSessions = useRef<Set<string>>(new Set());

  // 载入该会话的历史对话（平台不存消息，从 pi 会话文件还原）
  useEffect(() => {
    if (!activeId) return;
    if (loadedSessions.current.has(activeId)) return;
    let cancelled = false;
    setHistLoading(true);
    fetchSessionMessages(wakerId, activeId)
      .then((hist) => {
        if (cancelled) return;
        loadedSessions.current.add(activeId);
        setMsgsBySession((prev) => {
          const mapped = hist.map((m) => ({
            role: (m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'agent') as Msg['role'],
            text: m.text,
            at: m.at,
            steps: m.steps,
            images: m.images,
            compaction: m.compaction,
          }));
          // 历史在前、本地在后；按「时间+正文」去重，避免刚发的那条出现两次
          const seen = new Set(mapped.map((m) => `${m.at}|${m.text}`));
          const extra = (prev[activeId] ?? []).filter((m) => !seen.has(`${m.at}|${m.text}`));
          return { ...prev, [activeId]: [...mapped, ...extra] };
        });
      })
      .catch(() => {
        /* 历史读取失败不阻断对话 */
      })
      .finally(() => {
        if (!cancelled) setHistLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wakerId, activeId]);

  /** 待办跳转：命中消息的下标（命中后高亮 5s）。 */
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const focusDone = useRef(false);
  /**
   * 已经滚到过定位消息：之后**不再自动滚到底**。
   *
   * 实测 bug：高亮 5 秒后清除 focusIdx，滚动 effect 重新执行，把用户从目标消息
   * 一把拽回会话结尾。定位是"用户明确要看这里"，任何自动滚动都得让位。
   */
  const scrolledToFocus = useRef(false);

  // 换会话 / 换目标就重置，允许重新定位
  useEffect(() => {
    focusDone.current = false;
    scrolledToFocus.current = false;
    setFocusIdx(null);
  }, [focusText, activeId]);

  useEffect(() => {
    if (!focusText || focusDone.current || histLoading || !messages.length) return;
    /** 去掉引用前缀再比：任务流水里存的是带 `【回复此条】` 的原文。 */
    const norm = (s: string): string => s.replace(/【回复此条】[\s\S]*?\n\n/, '').replace(/\s+/g, ' ').trim();
    const want = norm(focusText);
    const q = want.slice(0, 40);
    // 无论找没找到都只试一次：否则每 5s 轮询都会把用户从当前位置拽走
    focusDone.current = true;
    if (!q) return;
    const idx = messages.findIndex((m) => {
      if (m.role !== 'user') return false;
      const t = norm(m.text);
      return t === q || t.startsWith(q) || want.startsWith(t);
    });
    if (idx >= 0) setFocusIdx(idx);
  }, [focusText, histLoading, messages]);

  // 命中后滚到目标：只滚这一次，且**不进"滚到底"的链路**（否则清除高亮时会被拽回结尾）
  useEffect(() => {
    if (focusIdx == null) return;
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(`[data-msg-idx="${focusIdx}"]`);
    if (target) {
      scrolledToFocus.current = true;
      target.scrollIntoView({ block: 'center' });
    }
  }, [focusIdx]);

  useEffect(() => {
    if (focusIdx == null) return;
    const timer = setTimeout(() => setFocusIdx(null), 5000);
    return () => clearTimeout(timer);
  }, [focusIdx]);

  // 只有没在定位时才"打开即滚到最新"（**不做平滑滚动**，打开即到位）
  useLayoutEffect(() => {
    if (scrolledToFocus.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, busy, activeId, histLoading]);

  const pushMsg = useCallback((sid: string, m: Msg): void => {
    setMsgsBySession((prev) => ({ ...prev, [sid]: [...(prev[sid] ?? []), m] }));
  }, []);

  /** 真正把消息发出去。话题判定之后才走到这里。 */
  const deliver = useCallback(
    async (sid: string, payload: string, attachments: TalkAttachment[]): Promise<void> => {
      // 自己发了新消息：退出"定位模式"，恢复跟随最新
      scrolledToFocus.current = false;
      /**
       * 附件预览跟着这条消息一起显示。
       *
       * 所以这里**不能** revoke 这些 blob URL（以前的 `clearPending()` 会 revoke，
       * 结果是刚发出去的图在气泡里立刻变成破图）。blob 由浏览器在组件卸载时回收。
       */
      const carried = pending.map((p) => ({ name: p.file.name, url: p.previewUrl }));
      pushMsg(sid, {
        role: 'user',
        text: payload,
        at: new Date().toISOString(),
        ...(carried.length ? { localAttachments: carried } : {}),
      });
      setPending([]);
      setAttachError('');
      setBusy(true);
      try {
        const res = await talkAgent(wakerId, payload, sid, attachments);
        if (res.blockedCount > 0) {
          pushMsg(sid, { role: 'system', text: `门禁拦截 ${res.blockedCount} 次`, at: new Date().toISOString() });
        }
        pushMsg(sid, {
          role: 'agent',
          text: res.result || res.error || '（无回复）',
          at: new Date().toISOString(),
          steps: res.steps ?? [],
        });
      } catch (e) {
        pushMsg(sid, { role: 'agent', text: `对话失败：${(e as Error)?.message ?? e}`, at: new Date().toISOString() });
      } finally {
        setBusy(false);
        // 本轮回复已落盘，刷新底部用量
        loadUsage();
      }
    },
    [wakerId, pushMsg, loadUsage, pending],
  );

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim();
    // 允许"只有附件、没有文字"：服务端会用默认话术兜底
    // 有未确认的建议 / 正在判定时不接新消息：否则会叠出第二条建议，第一条就孤零零挂着
    if ((!text && pending.length === 0) || busy || judging || suggestion || !activeId) return;
    const sid = activeId;

    // 先上传附件。失败就停在原地，**不能**把"图根本没传上去"的消息发出去 ——
    // 那会让模型对着一个不存在的附件回答，比报错更糟。
    let attachments: TalkAttachment[] = [];
    if (pending.length) {
      setBusy(true);
      try {
        const uploaded = await Promise.all(pending.map((p) => uploadAttachment(p.file)));
        // 带上原始文件名：会话文件里那行 `【附件：…】` 要能被人读懂
        attachments = uploaded.map((u) => ({ id: u.id, name: u.name }));
      } catch (e) {
        setAttachError(`附件上传失败：${(e as Error)?.message ?? e}`);
        setBusy(false);
        return;
      }
      setBusy(false);
    }

    // 有引用就拼成一条（拼好的文本既是给模型的输入，也是历史里回显的内容）
    const payload = quote ? composeQuoted(text, quote.ref, quote.mode).text : text;
    writeDraft(''); // 发出去了，草稿一并清掉
    setQuote(null);

    // 发送前先问一句"这句该装到别的会话里吗"。
    // 判定失败不影响发送——这只是个建议，不是关卡。
    // 纯附件消息没有文字可判，给判定器一个占位串，避免空输入直接返回。
    // 判定结果要留痕：判成"继续"时不会弹建议条，用户只能看到消息直接发出去，
    // 很容易以为"功能没生效"。所以每次判定都往消息流里放一行结论（本地消息，不落盘）。
    let verdict: string | null = null;
    setJudging(true);
    try {
      const s = await suggestTopic(wakerId, sid, payload || '（附件）');
      if (s.action === 'switch' && s.target && s.confidence >= 0.5) {
        setSuggestion({
          mode: 'switch',
          payload,
          attachments,
          targetId: s.target.id,
          targetTitle: s.target.title,
          recap: s.target.recap,
          similarity: s.target.similarity,
        });
        return;
      }
      // 新话题：与飞书同一套语义——"这看着像个新话题，要开一个新会话吗"
      if (s.action === 'new' && s.confidence >= 0.5) {
        const cur = sessions.find((x) => x.id === sid);
        setSuggestion({
          mode: 'new',
          payload,
          attachments,
          currentTitle: cur?.title || cur?.name,
        });
        return;
      }
      verdict = `话题判定：继续当前话题 · ${s.confidence.toFixed(2)} · ${s.regime}${
        s.reason ? `｜${s.reason}` : ''
      }`;
    } catch (e) {
      /* 判定不可用 → 直接发，但要说清楚是"没有判定"而不是"判定为继续" */
      verdict = `话题判定：不可用（${(e as Error)?.message ?? e}），直接发送`;
    } finally {
      setJudging(false);
    }
    if (verdict) pushMsg(sid, { role: 'system', text: verdict, at: new Date().toISOString() });
    await deliver(sid, payload, attachments);
  }, [input, pending, busy, judging, suggestion, activeId, quote, wakerId, writeDraft, deliver, sessions, pushMsg]);

  /**
   * 接受建议：切回旧话题 / 开个新会话，然后把这条发进去。
   *
   * 发之前先落一行状态（"已切到《X》，正在回答…"）：这是用户唯一能确认
   * "我点的那个动作真的生效了"的地方，等模型那几十秒里不能什么都不显示。
   */
  const acceptSuggestion = useCallback(async (): Promise<void> => {
    const s = suggestion;
    if (!s) return;
    setSuggestion(null);

    if (s.mode === 'switch' && s.targetId) {
      const fromTitle = activeSession?.title || activeSession?.name || activeId;
      const toTitle = s.targetTitle ?? s.targetId;
      setActiveId(s.targetId);
      // 消息流里留一条本地系统行：刷新页面后它不在 pi 历史里会消失，这是刻意的——
      // 它说明的是"刚刚发生了什么"，不是会话内容本身。
      pushMsg(s.targetId, {
        role: 'system',
        text: `已从《${fromTitle}》切到《${toTitle}》，这条提问装在这里`,
        at: new Date().toISOString(),
      });
      setJustSwitched(true);
      if (switchTimer.current) window.clearTimeout(switchTimer.current);
      switchTimer.current = window.setTimeout(() => setJustSwitched(false), 4000);
      flashNotice(`已切到《${toTitle}》，正在按你刚才那句回答…`, false);
      await deliver(s.targetId, s.payload, s.attachments);
      flashNotice('已处理完成');
      return;
    }

    // 新话题：先建会话再发。建不出来就说明白，并且**仍然把这条发给当前会话**，别悄悄丢掉
    try {
      const created = await createSession(wakerId);
      setSessions((prev) => [...prev, created]);
      setActiveId(created.id);
      flashNotice(`已在新会话《${created.title || created.name}》里回答…`, false);
      await deliver(created.id, s.payload, s.attachments);
      flashNotice('已处理完成');
    } catch (e) {
      flashNotice(null);
      setAttachError(`开新会话失败：${(e as Error)?.message ?? e}（已在当前会话发出）`);
      await deliver(activeId, s.payload, s.attachments);
    }
  }, [suggestion, deliver, flashNotice, wakerId, activeId, activeSession, pushMsg]);

  /** 忽略建议：就在当前会话发。同样落一行状态，别让人觉得"点了没反应"。 */
  const ignoreSuggestion = useCallback(async (): Promise<void> => {
    const s = suggestion;
    if (!s) return;
    setSuggestion(null);
    flashNotice('好，就在当前话题里回答…', false);
    await deliver(activeId, s.payload, s.attachments);
    flashNotice('已处理完成');
  }, [suggestion, activeId, deliver, flashNotice]);

  // Esc：先取消引用，再关窗（引用是"临时状态"，不该逼人为了取消它把整个对话关掉）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (quote) {
        setQuote(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, quote]);

  // 点面板之外的任何地方即收起（看板继续可操作）。输入框里的草稿已存本地，不会丢。
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const el = asideRef.current;
      if (el && !el.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    // 占半屏（小屏自动全宽）
    <aside
      ref={asideRef}
      className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface-900 shadow-lift md:w-1/2"
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <MessageSquare size={15} className="text-primary" />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-ink">{wakerName}</div>
          {/* 刚切换时头部亮 4 秒：那行名字变化太不起眼，用户会以为"点了没反应" */}
          <div
            className={`truncate text-[11px] ${justSwitched ? 'font-medium text-primary-deep' : 'text-ink-muted'}`}
          >
            {activeSession ? `话题：${activeSession.title || activeSession.name}` : '载入中…'}
            {justSwitched && (
              <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[10px] font-medium">刚切换</span>
            )}
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

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {histLoading && messages.length === 0 && (
          <div className="flex items-center justify-center gap-1.5 self-center py-6 text-[11px] text-ink-muted">
            <History size={12} /> 载入历史对话…
          </div>
        )}
        {!histLoading && messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center text-center text-ink-muted">
            <MessageSquare size={28} className="mb-2 opacity-40" />
            <div className="text-[13px]">和 {wakerName} 说点什么</div>
            <div className="mt-1 text-[11px]">这个会话还没有对话记录</div>
          </div>
        )}
        {messages.map((m, i) => {
          // 上下文压缩节点：**必须让人看见**，否则历史"像被删过"（旧实现真的删过，用户投诉过）。
          // 措辞里明确"记录完整保留"，并给出压了多少，免得再被误判成数据丢失。
          if (m.compaction) {
            return (
              <div key={i} className="my-1 flex items-center gap-2 self-stretch">
                <span className="h-px flex-1 bg-line" />
                <span
                  className="flex items-center gap-1.5 rounded-full border border-line bg-black/[0.03] px-2 py-0.5 text-[10px] text-ink-muted"
                  title="pi 原生压缩：在会话记录里插一个压缩节点，之前的对话一条都没删；下一轮从这里之后加载上下文"
                >
                  <Scissors size={10} className="text-primary" />
                  上下文已在此处压缩
                  {m.compaction.tokensBefore > 0 && `：约 ${fmtTokens(m.compaction.tokensBefore)} token`}
                  {m.compaction.summaryChars > 0 && ` → 摘要 ${m.compaction.summaryChars} 字`}
                  <span className="text-state-ok">· 记录完整保留</span>
                </span>
                <span className="h-px flex-1 bg-line" />
              </div>
            );
          }
          if (m.role === 'system') {
            return (
              <div key={i} className="flex items-center gap-1.5 self-center text-[11px] text-state-warn">
                <ShieldAlert size={12} /> {m.text}
              </div>
            );
          }
          const isUser = m.role === 'user';
          // 历史里带引用的消息：把引用块与正文分开渲染，否则刷新后会看到一堆 `【回复此条】`
          const quoted = m.role === 'user' ? parseQuoted(m.text) : null;
          /**
           * 这条消息附的图片：
           *  - 刚发出去 → 本地 blob（立即可见，不需要等 pi 写完会话文件）
           *  - 刷新后 → 服务端按 `line + index` 回取（图片二进制本来就在会话文件里，
           *    以前只读了 text 块，于是"发过图"在历史里完全消失）
           */
          const shots = isUser
            ? [
                ...(m.localAttachments ?? [])
                  .filter((a) => !!a.url)
                  .map((a) => ({ url: a.url as string, name: a.name })),
                ...(m.images ?? []).map((img) => ({
                  url: sessionImageUrl(wakerId, activeId, img.line, img.index),
                  name: '图片',
                })),
              ]
            : [];
          /** 文档类附件没有缩略图，给一行文件名（本地消息里才有）。 */
          const docs = isUser
            ? (m.localAttachments ?? []).filter((a) => !a.url).map((a) => a.name)
            : [];
          return (
            <div
              key={i}
              data-msg-idx={i}
              className={`group flex flex-col rounded-xl transition ${
                focusIdx === i ? 'bg-primary/[0.07] px-1.5 py-1 ring-1 ring-primary/35' : ''
              } ${isUser ? 'items-end' : 'items-start'}`}
            >
              {/* 执行过程：排在正文之前，默认收起，可展开看完整内容 */}
              {!isUser && !!m.steps?.length && <StepsBlock steps={m.steps} />}
              {/* 附件：图片给缩略图（点开看原图），文档给文件名。
                  与文字气泡分开渲染：只发图不打字时 `m.text` 为空，气泡不该是空盒子。 */}
              {isUser && (shots.length > 0 || docs.length > 0) && (
                <div className="flex max-w-[88%] flex-wrap justify-end gap-1.5">
                  {/* 缩略图用**固定尺寸**：flex 行里的 <a> 会被内容撑成不同宽度，
                      两张图大小不一、标注框也比图大一圈（实测）。点开看原图即可。 */}
                  {shots.map((s, k) => (
                    <a
                      key={k}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      title={`${s.name}（点开看原图）`}
                      className="block shrink-0 overflow-hidden rounded-lg border border-line"
                    >
                      <img
                        src={s.url}
                        alt={s.name}
                        loading="lazy"
                        className="block h-32 w-52 bg-black/[0.03] object-cover"
                      />
                    </a>
                  ))}
                  {docs.map((n, k) => (
                    <span
                      key={`d${k}`}
                      className="flex items-center gap-1 rounded-lg border border-line bg-black/[0.03] px-2 py-1 text-[11px] text-ink-muted"
                    >
                      <FileText size={11} className="shrink-0 text-primary/70" />
                      {n}
                    </span>
                  ))}
                </div>
              )}
              {!!m.text &&
                (isUser ? (
                  // 用户自己那条不渲染 Markdown：聊天框里随手敲的 "1. "、"*" 会被当结构改写
                  <div className="max-w-[88%] whitespace-pre-wrap rounded-xl bg-primary px-3 py-2 text-[13px] leading-relaxed text-white">
                    {quoted && (
                      <div className="mb-1.5 rounded-md border-l-2 border-white/50 bg-white/15 px-2 py-1 text-[11px] leading-relaxed text-white/85">
                        <span className="mb-0.5 block text-[10px] text-white/70">
                          {quoted.mode === 'reply' ? '回复' : '引用'} · {quoted.from === 'me' ? '我说的' : '你说的'}
                        </span>
                        {quoted.quote.length > 160 ? `${quoted.quote.slice(0, 160)}…` : quoted.quote}
                      </div>
                    )}
                    {quoted ? quoted.rest : m.text}
                  </div>
                ) : (
                  // 员工回复按 Markdown 渲染（**加粗** / ## 标题 / 列表 / 表格）
                  <div className="max-w-[88%] rounded-xl border border-line bg-black/[0.03] px-3 py-2 text-[13px] leading-relaxed text-ink">
                    <Md text={m.text} />
                  </div>
                ))}
              <div className={`mt-0.5 flex items-center gap-1.5 ${isUser ? 'flex-row-reverse' : ''}`}>
                {m.at && <span className="px-1 text-[10px] text-ink-muted">{formatDateTime(m.at)}</span>}
                {/* 悬停才出现：以这条为基础上继续问（回复=就它作答 / 引用=当背景参考） */}
                {!!m.text && (
                  <span className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={() => pickQuote(m, 'reply')}
                      className="flex items-center gap-0.5 rounded border border-line px-1 py-px text-[10px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
                      title="以这条为基础回答"
                    >
                      <CornerUpLeft size={9} /> 回复
                    </button>
                    <button
                      type="button"
                      onClick={() => pickQuote(m, 'quote')}
                      className="flex items-center gap-0.5 rounded border border-line px-1 py-px text-[10px] text-ink-muted transition hover:border-primary/40 hover:text-ink"
                      title="把这条作为背景引用"
                    >
                      <Quote size={9} /> 引用
                    </button>
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {busy && (
          <div className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            <Loader2 size={13} className="animate-spin" /> {wakerName} 正在思考…
          </div>
        )}
      </div>

      {/* 判定中：这一行只在判定真的慢时才有存在感，但它解释了"为什么还没发出去" */}
      {judging && !suggestion && (
        <div className="flex items-center gap-1.5 border-t border-line bg-primary/[0.04] px-3 py-2 text-[11px] text-ink-muted">
          <Loader2 size={11} className="animate-spin" /> 正在判断这句该装进哪个话题…
        </div>
      )}

      {/* 接受建议后的落地状态：切过去了 / 正在回答 / 已完成，都看得见，不用猜 */}
      {notice && (
        <div className="border-t border-line bg-black/[0.02] px-3 py-2 text-[11px] text-ink-muted">{notice}</div>
      )}

      {/* 话题建议：判定在发送之前，所以此刻这条消息还没写进任何会话 */}
      {suggestion && (
        <div className="border-t border-line bg-primary/[0.05] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-px shrink-0 rounded bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary-deep">
              话题
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] leading-relaxed text-ink">
                {suggestion.mode === 'new' ? '这看着像个新话题' : `这句像是在聊《${suggestion.targetTitle}》`}
                {suggestion.mode === 'switch' && typeof suggestion.similarity === 'number' && (
                  <span className="ml-1 text-ink-muted">（相似度 {suggestion.similarity.toFixed(2)}）</span>
                )}
              </div>
              {suggestion.mode === 'new' && (
                <div className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                  前面在聊《{suggestion.currentTitle || '当前话题'}》，开个新会话可以免得两件事搅在一起。
                </div>
              )}
              {suggestion.recap && (
                <div className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-ink-muted">
                  {suggestion.recap}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void acceptSuggestion()}
                  className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-primary-deep"
                >
                  {suggestion.mode === 'new' ? '开新会话并发送' : '切过去并发送'}
                </button>
                <button
                  type="button"
                  onClick={() => void ignoreSuggestion()}
                  className="rounded-lg border border-line px-2.5 py-1 text-[11px] text-ink-muted transition hover:text-ink"
                >
                  就在这儿发
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSuggestion(null)}
              className="mt-px shrink-0 rounded p-0.5 text-ink-muted transition hover:text-ink"
              title="取消（这条不会发出）"
            >
              <X size={11} />
            </button>
          </div>
        </div>
      )}

      {/* 待发送的引用：一眼看清"我在对哪条说话"，可取消 */}
      {quote && (
        <div className="flex items-start gap-2 border-t border-line bg-black/[0.02] px-3 py-2">
          <span className="mt-px shrink-0 rounded bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary-deep">
            {quote.mode === 'reply' ? '回复' : '引用'}
          </span>
          <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-muted">
            <span className="text-ink-muted/70">{quote.ref.from === 'me' ? '我说的' : '你说的'}：</span>
            <span className="lines-clamp-2">{quote.ref.text.slice(0, 200)}</span>
          </div>
          <button
            type="button"
            onClick={() => setQuote(null)}
            className="mt-px shrink-0 rounded p-0.5 text-ink-muted transition hover:text-ink"
            title="取消引用（Esc）"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* 待发送附件：图片给缩略图，文档给文件名；悬停出现删除按钮 */}
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-3 pt-2">
          {pending.map((p) => (
            <div key={p.key} className="group relative">
              {p.kind === 'image' && p.previewUrl ? (
                <img
                  src={p.previewUrl}
                  alt={p.file.name}
                  className="h-14 w-14 rounded-lg border border-line object-cover"
                />
              ) : (
                <div className="flex h-14 max-w-[200px] items-center gap-1.5 rounded-lg border border-line bg-black/[0.03] px-2">
                  <FileText size={13} className="shrink-0 text-primary/70" />
                  <span className="truncate text-[11px] text-ink-muted">{p.file.name}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeFile(p.key)}
                title="移除这个附件"
                className="absolute -right-1.5 -top-1.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition group-hover:opacity-100"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachError && <div className="px-3 pt-1 text-[11px] text-red-500">{attachError}</div>}

      <div
        className="flex gap-2 border-t border-line p-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(Array.from(e.dataTransfer?.files ?? []));
        }}
      >
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          // 用与输入框同款的浅底 + 正文色图标：原来的 muted 灰配 10% 边框在浅背景上几乎看不见，
          // 用户会以为这个功能不存在。可点的控件不该看起来像禁用。
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-black/[0.03] text-ink transition hover:bg-black/[0.07] disabled:opacity-40"
          title="添加图片或文件（也可以直接粘贴、拖进来）"
          aria-label="添加附件"
        >
          <Paperclip size={15} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            // 清空 value，否则连续选同一个文件不会触发 change
            e.target.value = '';
          }}
        />
        <textarea
          value={input}
          onChange={(e) => writeDraft(e.target.value)}
          onPaste={(e) => {
            // 截图直接粘：剪贴板里的图片以 File 形式出现
            const files = Array.from(e.clipboardData?.files ?? []);
            if (!files.length) return;
            e.preventDefault();
            addFiles(files);
          }}
          onKeyDown={(e) => {
            // ⌘/Ctrl + Enter 发送；单独 Enter 留给换行（长指令是多行的，误发代价大）
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="输入消息，⌘+Enter 发送；图片可直接粘贴或拖入"
          className="min-h-[56px] flex-1 resize-none rounded-lg border border-line bg-black/[0.03] px-3 py-2 text-[13px] text-ink outline-none transition focus:border-primary/50"
        />
        <button
          onClick={send}
          disabled={busy || judging || !!suggestion || (!input.trim() && pending.length === 0)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary text-white transition hover:bg-primary-deep disabled:opacity-40"
          aria-label="发送"
          title={suggestion ? '先处理上面的建议，或点「取消」' : undefined}
        >
          <Send size={15} />
        </button>
      </div>

      {/* 底部状态行：本会话累计用量（费用按模型价格表计算） */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line px-3 py-1.5 text-[10px] text-ink-muted">
        <Coins size={11} className="text-primary" />
        <span className="font-mono">
          {fmtTokens(usage?.tokens ?? 0)} tokens · {fmtCost(usage?.cost ?? 0)}
        </span>
        {!!usage?.models.length && (
          <span
            className="truncate"
            title={usage.models
              .map((m) => `${m.model}：${m.tokens.toLocaleString()} tokens · ${fmtCost(m.cost)}`)
              .join('\n')}
          >
            （{usage.models
              .slice(0, 2)
              .map((m) => `${m.model} ${fmtTokens(m.tokens)}`)
              .join(' · ')}
            {usage.models.length > 2 ? ` 等 ${usage.models.length} 个模型` : ''}）
          </span>
        )}
        <span className="ml-auto shrink-0">
          {usage && usage.tokens > 0 && usage.source === 'recorded' ? '按 pi 记录计费' : '按模型价格表计算'}
        </span>
      </div>
    </aside>
  );
}
