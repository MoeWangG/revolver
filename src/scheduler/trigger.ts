import type { AutomationDef, TaskRecord } from '../types.ts';
import { runWaker } from '../core/runner.ts';
import { loadAutomations } from './cron.ts';
import { createSession, resolveSessionByKey, touchSession } from '../core/sessions.ts';

/** 会话名里的时间戳：`MM-DD HH:mm`。 */
function stamp(): string {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(
    now.getHours(),
  ).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * 按路径取值，支持 `a.b.c` 与 `items[0].name`。
 * 取不到返回 undefined，由调用方决定降级策略。
 */
function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const rawKey of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(rawKey.trim());
    if (!m) return undefined;
    const [, key = '', idxPart = ''] = m;
    cur = (cur as Record<string, unknown>)[key];
    for (const idx of idxPart.match(/\d+/g) ?? []) {
      if (Array.isArray(cur)) cur = cur[Number(idx)];
      else return undefined;
    }
  }
  return cur;
}

/**
 * 渲染 `{{field}}` 占位符。
 *
 * 与 QoderWake 一致：**找不到字段时保留原占位符**，而不是替换成空串。
 * 这样字段路径写错时能在任务描述里直接看出来，便于定位。
 */
export function renderTemplate(tpl: string, payload: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_.[\]]+)\s*\}\}/g, (whole, path: string) => {
    const v = getByPath(payload, path);
    if (v === undefined || v === null) return whole;
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** 找出带 API 触发的任务。 */
function findApiAutomation(name: string): AutomationDef | null {
  return (
    loadAutomations().find((a) => a.enabled && a.triggers.some((t) => t.kind === 'api' && t.name === name)) ?? null
  );
}

/**
 * API 触发入口。
 * 注意：`sessionKey` 用于延续上下文（同一业务对象多次调用复用同一会话），
 * 但它**不是幂等键**——调用方仍需自己做重试去重。
 */
export async function fireApi(
  name: string,
  payload: Record<string, unknown>,
  sessionKey?: string,
): Promise<TaskRecord> {
  const def = findApiAutomation(name);
  if (!def) throw new Error(`未找到名为 ${name} 的 API 触发任务`);
  const prompt = renderTemplate(def.promptTemplate, payload);
  // 产出按次归档：不传 sessionKey 就新开一个会话；传了就复用同一外部键对应的会话
  const session = sessionKey
    ? resolveSessionByKey(def.wakerId, `api:${name}:${sessionKey}`, `API·${def.name}`)
    : createSession(def.wakerId, `API·${def.name} ${stamp()}`);
  const task = await runWaker({
    wakerId: def.wakerId,
    prompt,
    source: 'api',
    sessionId: session.piSessionId,
    wakerSessionId: session.id,
  });
  touchSession(def.wakerId, session.id, 2);
  return task;
}

/** 事件触发入口：目前按名称匹配 api 类型触发器，便于统一流水线。 */
export async function fireEvent(name: string, payload: Record<string, unknown>): Promise<TaskRecord> {
  return fireApi(name, payload);
}
