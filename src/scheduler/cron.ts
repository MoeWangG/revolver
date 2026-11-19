import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import cron from 'node-cron';
import type { AutomationDef, TriggerSpec } from '../types.ts';
import { AUTOMATIONS_FILE, DATA_DIR } from '../core/paths.ts';
import { runWaker } from '../core/runner.ts';
import { createSession, touchSession } from '../core/sessions.ts';

function ensureFile(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(AUTOMATIONS_FILE)) writeFileSync(AUTOMATIONS_FILE, '[]', 'utf-8');
}

export function loadAutomations(): AutomationDef[] {
  ensureFile();
  try {
    const parsed = JSON.parse(readFileSync(AUTOMATIONS_FILE, 'utf-8')) as AutomationDef[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveAutomations(list: AutomationDef[]): void {
  ensureFile();
  writeFileSync(AUTOMATIONS_FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf-8');
}

export function createAutomation(input: Omit<AutomationDef, 'id' | 'runCount' | 'createdAt'>): AutomationDef {
  const def: AutomationDef = {
    ...input,
    id: randomUUID(),
    runCount: 0,
    createdAt: new Date().toISOString(),
  };
  saveAutomations([...loadAutomations(), def]);
  return def;
}

/** 删除一条自动任务。 */
export function deleteAutomation(id: string): boolean {
  const list = loadAutomations();
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return false;
  saveAutomations(next);
  return true;
}

/** 启用/停用一条自动任务。 */
export function setAutomationEnabled(id: string, enabled: boolean): AutomationDef | null {
  const list = loadAutomations();
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx]!, enabled };
  saveAutomations(list);
  return list[idx]!;
}

function bumpRunCount(id: string): void {
  const list = loadAutomations();
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx]!, runCount: (list[idx]!.runCount ?? 0) + 1 };
  saveAutomations(list);
}

/** 判断是否还要继续跑：超次数或过截止日期即停用。 */
function exhausted(def: AutomationDef, spec: TriggerSpec): boolean {
  if ('maxRuns' in spec && typeof spec.maxRuns === 'number' && (def.runCount ?? 0) >= spec.maxRuns) return true;
  if ('until' in spec && typeof spec.until === 'string' && new Date(spec.until).getTime() < Date.now()) return true;
  return false;
}

/**
 * 执行一条自动任务。审批类失败不重试，交给下次触发。
 *
 * **每次触发都开一个新会话**：定时任务的产出（提问、答复、工具步骤、token 与费用）
 * 按次归到一个独立会话里，既便于回溯"这次跑出了什么"，也不会把默认会话冲乱。
 */
async function fire(def: AutomationDef, source: 'cron' | 'api'): Promise<void> {
  if (!def.enabled) return;
  bumpRunCount(def.id);
  const now = new Date();
  const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(
    now.getHours(),
  ).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const session = createSession(def.wakerId, `定时·${def.name} ${stamp}`);
  await runWaker({
    wakerId: def.wakerId,
    prompt: def.promptTemplate,
    source,
    sessionId: session.piSessionId,
    wakerSessionId: session.id,
    // 关联到具体任务：看板的面板统计只算"当前仍存在"的任务，不至于删了任务还留着计数
    automationId: def.id,
  });
  // 一次触发产生「提问 + 答复」，据此累计会话消息数
  touchSession(def.wakerId, session.id, 2);
}

const registered = new Set<string>();

/**
 * 启动调度器。幂等：重复调用不会重复注册同一条任务。
 * 返回已注册的条数，便于 CLI 输出。
 */
export function startScheduler(): number {
  let count = 0;
  for (const def of loadAutomations()) {
    if (!def.enabled) continue;
    for (const spec of def.triggers) {
      if (spec.kind !== 'cron') continue;
      const key = `${def.id}:${spec.cron}`;
      if (registered.has(key)) continue;
      registered.add(key);

      const tz = spec.timezone ?? 'Asia/Shanghai';
      cron.schedule(
        spec.cron,
        async () => {
          try {
            if (exhausted(def, spec)) return;
            await fire(def, 'cron');
          } catch (e) {
            console.error(`[cron] 任务 ${def.name} 执行失败:`, (e as Error)?.message ?? e);
          }
        },
        { timezone: tz },
      );
      count += 1;
    }
  }
  return count;
}

/** 处理一次性任务：到点后执行并自动停用。 */
export function scheduleOnce(): number {
  let count = 0;
  for (const def of loadAutomations()) {
    if (!def.enabled) continue;
    for (const spec of def.triggers) {
      if (spec.kind !== 'once') continue;
      const at = new Date(spec.at).getTime();
      const delay = at - Date.now();
      if (delay <= 0 || delay > 24 * 3600 * 1000) continue; // 超出一天窗口的留给下轮调度
      const key = `once:${def.id}:${spec.at}`;
      if (registered.has(key)) continue;
      registered.add(key);
      setTimeout(async () => {
        try {
          await fire(def, 'cron');
        } catch (e) {
          console.error(`[once] 任务 ${def.name} 执行失败:`, (e as Error)?.message ?? e);
        }
      }, delay).unref?.();
      count += 1;
    }
  }
  return count;
}

export function stopScheduler(): void {
  // node-cron 的 getTasks() 返回 [name, task] 元组数组
  for (const [, task] of cron.getTasks()) task.stop();
  registered.clear();
}

/**
 * 重新注册全部定时任务。
 *
 * **任何增删改之后都必须调用**：已注册的 node-cron 任务不会因为
 * `automations.json` 变化而停止——否则会出现"删掉的任务还在跑"。
 */
export function reloadScheduler(): number {
  stopScheduler();
  return startScheduler() + scheduleOnce();
}
