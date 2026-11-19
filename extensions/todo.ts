/**
 * waker-todo — 让 agent 在对话里「留任务」的通道
 *
 * ## 为什么必须是一个工具
 *
 * 实测：用户说「留一个任务，11 月 7 日…」时，模型会自己去写一份 `待办.md`、
 * 存一条记忆，然后**声称**"已记录，到时候提醒你"——平台里其实什么都没有，
 * 到点也不会有人被提醒。问题不在意愿，而在**它没有别的通道可用**：
 * bash 前缀白名单不允许 `waker`，看板接口也不在它的工具集里。
 *
 * ## 两个设计约束
 *
 * 1. **不经过 bash**：直接 `fetch` 看板 API。否则会被 waker-guard 的命令白名单拦掉，
 *    模型只能退回"写个文件 + 口头承诺"。
 * 2. **工具描述里写死强制条款**：工具存在 ≠ 模型会用。必须明确"留任务/提醒类请求
 *    必须调用本工具，没拿到成功不许说已记录"，否则会复现上面那次。
 *
 * ## 环境变量（由 Runner 在 spawn pi 时注入）
 *   WAKER_ID         员工 id
 *   WAKER_BOARD_URL  看板地址（默认 http://127.0.0.1:8787）
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const WAKER_ID = (process.env.WAKER_ID ?? '').trim();
/** 当前这轮任务与平台会话：写进 todo，看板才能跳回"具体是哪条消息"。 */
const TASK_ID = (process.env.WAKER_TASK_ID ?? '').trim();
const SESSION_ID = (process.env.WAKER_SESSION_ID ?? '').trim();
const BOARD_URL = (process.env.WAKER_BOARD_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TIMEOUT_MS = 8000;

function ok(text: string): { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

async function call(path: string, init?: RequestInit): Promise<{ ok: boolean; body: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BOARD_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 就保留原文，便于排查 */
    }
    return { ok: res.ok, body };
  } catch (e) {
    return { ok: false, body: `看板接口不可达：${(e as Error)?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把模型给的时间规范化成 ISO8601。
 *
 * 模型可能给 `2026-11-07`、`2026-11-07 09:00`、`2026-11-07T09:00:00+08:00`。
 * 只给日期时统一落到**本地 09:00**——"留个任务给某天"几乎都指早上开始做，
 * 落在 00:00 会让提醒在半夜闪。
 */
function normalizeDue(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T09:00:00`);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const withT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') : s;
  const d = new Date(withT);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function fmtLocal(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const NOT_RECORDED =
  '⚠️ 这次**没有**记录成功。请如实告诉用户"没记上"，不要声称已安排。' +
  '若是看板没开，让用户先启动 `waker board`，或直接在看板「待办」里手动新建。';

export default function wakerTodo(pi: ExtensionAPI): void {
  if (!WAKER_ID) return;

  const assigneeDesc =
    'human = 人到点自己被提醒（默认）；agent = 你到点自己去做（会自动沿用当前会话执行，并把结果发回原窗口）';

  pi.registerTool({
    name: 'todo_add',
    label: '留一个任务',
    description:
      '把「某天要做某事」落成平台待办（看板可见、到点提醒或到点自己执行）。' +
      `assignee 决定谁来做：${assigneeDesc}。` +
      '**强制规则**：用户说"留个任务 / 提醒我 / 到某天做 X"时，必须调用本工具；' +
      '没拿到成功结果就不许回复"已记录 / 已安排 / 到时候提醒你"。只写文件或只存记忆都不算记录。',
    promptSnippet: '用户让你留任务 / 设提醒 / 安排某天做某事时，用 todo_add 落到平台',
    promptGuidelines: [
      '用户自己要做的事选 assignee=human；明确让"你"到点去做的选 assignee=agent。',
      `dueAt 用 ISO8601 或 YYYY-MM-DD HH:mm；只给日期时按当天 09:00 处理。拿不准就照用户原话写，不要自己改日子。`,
      '调用失败时必须如实说失败，并给出下一步（启动看板 / 手动新建），绝不能说"已记录"。',
    ],
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题，一句话说清要做什么' },
        dueAt: { type: 'string', description: '截止时间：YYYY-MM-DD 或 YYYY-MM-DD HH:mm（或带时区的 ISO8601）' },
        assignee: { type: 'string', description: assigneeDesc },
        detail: { type: 'string', description: '补充说明（上下文、验收标准），可选' },
      },
      required: ['title', 'dueAt'],
    },
    execute: async (
      _id: string,
      params: { title?: string; dueAt?: string; assignee?: string; detail?: string },
    ) => {
      const title = (params?.title ?? '').trim();
      if (!title) return ok('缺少 title，请先明确要做什么再记录。');
      const dueAt = normalizeDue(params?.dueAt ?? '');
      if (!dueAt) return ok(`无法识别截止时间「${params?.dueAt ?? ''}」。请用 2026-11-07 或 2026-11-07 09:00 这种格式。`);
      const assignee = params?.assignee === 'agent' ? 'agent' : 'human';

      const r = await call('/api/todos', {
        method: 'POST',
        body: JSON.stringify({
          wakerId: WAKER_ID,
          title,
          dueAt,
          assignee,
          detail: params?.detail,
          // 由 Runner 注入：这轮任务 id + 平台会话 id，供看板精确跳回原消息
          sessionId: SESSION_ID || undefined,
          sourceTaskId: TASK_ID || undefined,
        }),
      });
      if (!r.ok) return ok(`记录失败：${typeof r.body === 'string' ? r.body : r.body?.error ?? JSON.stringify(r.body)}\n\n${NOT_RECORDED}`);

      const t = r.body as { id?: string; dueAt?: string };
      const who = assignee === 'agent' ? '我到点自己做，结果会发回这个窗口' : '到点会提醒你';
      return ok(
        `✅ 已记录：${title}\n截止：${fmtLocal(t.dueAt ?? dueAt)}（${who}）\nid：${t.id ?? '(未知)'}\n\n` +
          '这条已经进看板「待办」，可以在那里结束 / 关闭 / 顺延。',
      );
    },
  });

  pi.registerTool({
    name: 'todo_list',
    label: '查看任务',
    description: '列出当前待办（默认只看未完成的）。回答"我有哪些任务"时用它，不要凭记忆编。',
    parameters: {
      type: 'object',
      properties: {
        includeDone: { type: 'boolean', description: 'true 时连带已完成 / 已关闭的一起列' },
      },
    },
    execute: async (_id: string, params: { includeDone?: boolean }) => {
      const r = await call(`/api/todos?wakerId=${encodeURIComponent(WAKER_ID)}`);
      if (!r.ok) return ok(`读取失败：${typeof r.body === 'string' ? r.body : r.body?.error ?? ''}`);
      const list = (Array.isArray(r.body) ? r.body : []) as Array<Record<string, any>>;
      const rows = params?.includeDone ? list : list.filter((t) => t.status === 'pending' || t.status === 'running');
      if (!rows.length) return ok('当前没有未完成的待办。');
      const lines = rows.map(
        (t) =>
          `- ${t.title}｜${fmtLocal(String(t.dueAt))}｜${t.assignee === 'agent' ? '我做' : '你做'}｜${
            t.status === 'running' ? '执行中' : t.status === 'pending' ? '未完成' : t.status
          }${t.id ? `｜id=${String(t.id).slice(0, 8)}` : ''}`,
      );
      return ok([`共 ${rows.length} 条：`, ...lines].join('\n'));
    },
  });

  pi.registerTool({
    name: 'todo_done',
    label: '结束任务',
    description: '把一条待办标记为完成（用户说"做完了 / 这条结束了"时用）。只能改你名下的待办。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待办 id（可用 todo_list 查到）' },
        note: { type: 'string', description: '一句话结果 / 备注，可选' },
      },
      required: ['id'],
    },
    execute: async (_id: string, params: { id?: string; note?: string }) => {
      const id = (params?.id ?? '').trim();
      if (!id) return ok('缺少 id。先用 todo_list 查到具体是哪一条。');
      const r = await call(`/api/todos/${encodeURIComponent(id)}/done`, {
        method: 'POST',
        body: JSON.stringify({ note: params?.note }),
      });
      if (!r.ok) return ok(`结束失败：${typeof r.body === 'string' ? r.body : r.body?.error ?? ''}`);
      return ok(`已结束：${r.body?.title ?? id}`);
    },
  });

  pi.registerTool({
    name: 'todo_snooze',
    label: '顺延任务',
    description: '把一条待办往后推（默认 1 天）。用户说"过两天再说 / 晚点提醒"时用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待办 id' },
        days: { type: 'number', description: '往后推几天，默认 1' },
      },
      required: ['id'],
    },
    execute: async (_id: string, params: { id?: string; days?: number }) => {
      const id = (params?.id ?? '').trim();
      if (!id) return ok('缺少 id。先用 todo_list 查到具体是哪一条。');
      const days = typeof params?.days === 'number' && params.days > 0 ? params.days : 1;
      const r = await call(`/api/todos/${encodeURIComponent(id)}/snooze`, {
        method: 'POST',
        body: JSON.stringify({ ms: days * 24 * 3600 * 1000 }),
      });
      if (!r.ok) return ok(`顺延失败：${typeof r.body === 'string' ? r.body : r.body?.error ?? ''}`);
      return ok(`已顺延到：${fmtLocal(String(r.body?.dueAt ?? ''))}`);
    },
  });

  console.error(`[waker-todo] 已为 ${WAKER_ID} 注册 todo_add / todo_list / todo_done / todo_snooze（看板 ${BOARD_URL}）`);
}
