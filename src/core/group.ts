import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { GroupDef, TaskRecord } from '../types.ts';
import { DATA_DIR, GROUPS_FILE } from './paths.ts';
import { runWaker } from './runner.ts';

function ensureFile(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(GROUPS_FILE)) writeFileSync(GROUPS_FILE, '[]', 'utf-8');
}

export function loadGroups(): GroupDef[] {
  ensureFile();
  try {
    const parsed = JSON.parse(readFileSync(GROUPS_FILE, 'utf-8')) as GroupDef[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveGroups(list: GroupDef[]): void {
  ensureFile();
  writeFileSync(GROUPS_FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf-8');
}

export function getGroup(id: string): GroupDef | null {
  return loadGroups().find((g) => g.id === id) ?? null;
}

/** 校验：同一目录只允许一位主修改者，防止并发覆盖。 */
export function validateGroup(g: GroupDef): string[] {
  const errors: string[] = [];
  const ids = g.members.map((m) => m.wakerId);
  if (!ids.includes(g.leaderId)) errors.push('Leader 必须是成员之一');
  if (new Set(ids).size !== ids.length) errors.push('成员存在重复');
  const writers = g.members.filter((m) => m.isPrimaryWriter && !m.readOnly);
  if (writers.length > 1) errors.push(`主修改者只能有一位，当前有 ${writers.length} 位：${writers.map((w) => w.wakerId).join(', ')}`);
  return errors;
}

export interface GroupRunResult {
  groupRunId: string;
  groupId: string;
  /** Leader 拆解出的成员任务。 */
  memberTasks: TaskRecord[];
  summary: string;
  failedCount: number;
}

/**
 * 执行一次 Group 编排。
 *
 * 分工模型参考 Worker-Checker：成员各自执行（Worker），
 * 主修改者唯一，其余成员只读评审（Checker），最后由 Leader 汇总。
 * 这里刻意**不做**成员间的自由对话，避免上下文串味和责任模糊。
 */
export async function runGroup(groupId: string, goal: string): Promise<GroupRunResult> {
  const g = getGroup(groupId);
  if (!g) throw new Error(`未找到 Group：${groupId}`);
  const errors = validateGroup(g);
  if (errors.length) throw new Error(`Group 配置不合法：${errors.join('; ')}`);

  const groupRunId = randomUUID();

  // 成员并行：互不依赖的子任务同时推进，失败不阻断其他人
  const settled = await Promise.allSettled(
    g.members.map((m) =>
      runWaker({
        wakerId: m.wakerId,
        prompt: [
          `你正在参与团队任务「${g.title}」，你的分工是：${m.brief}`,
          m.readOnly ? '你是评审者：只做分析，不要修改任何文件。' : '',
          m.isPrimaryWriter ? '你是主修改者：只有你可以写入最终结果文件。' : '',
          '',
          `总体目标：${goal}`,
        ]
          .filter(Boolean)
          .join('\n'),
        source: 'cli',
        groupRunId,
      }),
    ),
  );

  const memberTasks: TaskRecord[] = [];
  const outcome: string[] = [];
  let failedCount = 0;

  settled.forEach((s, i) => {
    const member = g.members[i]!;
    if (s.status === 'fulfilled') {
      memberTasks.push(s.value);
      if (s.value.status === 'success') {
        outcome.push(`## ${member.wakerId}\n${(s.value.result ?? '(无输出)').slice(0, 2000)}`);
      } else {
        failedCount += 1;
        outcome.push(`## ${member.wakerId}\n执行失败：${s.value.error ?? '未知原因'}`);
      }
    } else {
      failedCount += 1;
      outcome.push(`## ${member.wakerId}\n未启动：${String(s.reason)}`);
    }
  });

  // Leader 汇总：拿到全部成员产出后再做一次整合，保证结论一致
  const summaryTask = await runWaker({
    wakerId: g.leaderId,
    prompt: [
      `你是团队「${g.title}」的负责人，请把以下成员产出汇总为一份面向使用者的结论。`,
      '要求：指出已完成项、未完成项、存在的冲突，以及需要人工确认的事项。',
      '',
      `总体目标：${goal}`,
      '',
      outcome.join('\n\n'),
    ].join('\n'),
    source: 'cli',
    groupRunId,
  });

  return {
    groupRunId,
    groupId,
    memberTasks,
    summary: summaryTask.result ?? '（Leader 未返回汇总）',
    failedCount,
  };
}
