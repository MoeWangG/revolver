/**
 * waker-selfedit — 员工修改自己档案的通道
 *
 * 只有在 `policy.selfEdit: true` 时才注册工具；默认关闭。
 *
 * ## 为什么值得单独开一个工具，而不是"把写权限放开"
 *
 * 员工的档案（`agents/<id>/{SOUL,identity,persona,bible,MEMORY}.md`）里写的是它自己的
 * 人设与红线。让它能改自己，风险不在"写文件"这个动作，而在**没有任何痕迹、也回不去**。
 * 所以这里把"能不能改"变成三件可核查的事，都不依赖它自觉：
 *
 * 1. **可改范围固定**：只有那五份档案。`waker.yaml`（权限：工具/命令/目录白名单、沙箱、
 *    以及本开关）**不在其中** —— 它无法自我扩权，也无法给自己解除门禁。
 * 2. **写前强制备份**：旧内容落到 `data/identity-history/<id>/`，人工随时回滚。
 * 3. **每次留痕**：追加一行到 `data/selfedit.jsonl`（含它写的理由与提交前后字节数）。
 *
 * ## 生效时机
 *
 * 写回后**不重新编译**，也不去调看板接口：外壳在每次 spawn pi 之前都会
 * `writeCompiledArtifacts(rec)`（见 core/runner.ts 的 spawnRun），所以下一个任务/下一轮对话
 * 自然就拿到了新档案。这样本扩展**完全不依赖看板进程是否在跑**（CLI 直跑 `waker say` 也成立）。
 *
 * ## 环境变量（由 Runner 在 spawn pi 时注入）
 *   WAKER_ID          员工 id
 *   WAKER_POLICY_DIR  编译产物目录（`<platform>/data/policy`），据此反推平台根目录
 * 另兼容 WAKER_AGENTS / WAKER_DATA（平台侧同一套覆盖变量），避免自定路径下认错地方。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const WAKER_ID = process.env.WAKER_ID ?? '';
const POLICY_DIR = process.env.WAKER_POLICY_DIR ?? '';

/** 平台根目录：`<root>/data/policy` 往上两级。 */
const PLATFORM_ROOT = POLICY_DIR ? resolve(POLICY_DIR, '..', '..') : '';
const AGENTS_DIR = process.env.WAKER_AGENTS ?? (PLATFORM_ROOT ? join(PLATFORM_ROOT, 'agents') : '');
const DATA_DIR = process.env.WAKER_DATA ?? (PLATFORM_ROOT ? join(PLATFORM_ROOT, 'data') : '');

/** 可改的档案（白名单硬编码在这里，与平台侧 EDITABLE_FILES 一致；waker.yaml 永远不在其中）。 */
const EDITABLE = ['SOUL.md', 'identity.md', 'persona.md', 'bible.md', 'MEMORY.md'] as const;

/** 单次写入上限（字符）。档案是文本，超过这个量级基本是模型写疯了，拦下来让人看一眼。 */
const MAX_WRITE_CHARS = 100_000;
/** 读回内容的上限（字符）：避免一次把大文件灌进上下文。 */
const MAX_READ_CHARS = 20_000;

const AGENT_DIR = WAKER_ID ? join(AGENTS_DIR, WAKER_ID) : '';
const HISTORY_DIR = DATA_DIR && WAKER_ID ? join(DATA_DIR, 'identity-history', WAKER_ID) : '';
const AUDIT_FILE = DATA_DIR ? join(DATA_DIR, 'selfedit.jsonl') : '';

interface Policy {
  wakerId?: string;
  selfEdit?: boolean;
}

function loadPolicy(): Policy | null {
  if (!WAKER_ID || !POLICY_DIR) return null;
  const p = join(POLICY_DIR, `${WAKER_ID}.policy.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Policy;
  } catch (e) {
    console.error('[waker-selfedit] 策略解析失败:', (e as Error)?.message ?? e);
    return null;
  }
}

const POLICY = loadPolicy();

function ok(text: string): { content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: 'text' as const, text }], details: {} };
}

interface FileState {
  name: string;
  path: string;
  exists: boolean;
  bytes: number;
  updatedAt: string | null;
  content: string;
}

function readState(name: string): FileState {
  const path = join(AGENT_DIR, name);
  if (!existsSync(path)) return { name, path, exists: false, bytes: 0, updatedAt: null, content: '' };
  const content = readFileSync(path, 'utf-8');
  const st = statSync(path);
  return { name, path, exists: true, bytes: st.size, updatedAt: st.mtime.toISOString(), content };
}

/** 时间戳做成文件名安全的样子（冒号在 macOS 上是合法字符，但输出给人看时容易歧义）。 */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 备份旧内容，返回备份文件路径（旧文件不存在时返回 null）。 */
function backup(state: FileState): string | null {
  if (!state.exists) return null;
  if (!HISTORY_DIR) return null;
  mkdirSync(HISTORY_DIR, { recursive: true });
  const dest = join(HISTORY_DIR, `${state.name}.${stamp()}.bak`);
  writeFileSync(dest, state.content, 'utf-8');
  return dest;
}

/** 留痕：一行一条，便于之后 grep 出"谁在什么时候改了什么"。 */
function audit(entry: Record<string, unknown>): void {
  if (!AUDIT_FILE) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (e) {
    // 留痕失败不该阻断写入（档案已经改完了），但一定要吼一声
    console.error('[waker-selfedit] 留痕失败:', (e as Error)?.message ?? e);
  }
}

export default function wakerSelfEdit(pi: ExtensionAPI): void {
  if (!POLICY?.selfEdit) return; // 默认关闭：不注册工具，模型看不到它，也没有额外开销
  if (!AGENT_DIR || !DATA_DIR) {
    console.error('[waker-selfedit] 缺少 WAKER_ID / WAKER_POLICY_DIR，无法定位档案目录，工具未注册');
    return;
  }

  console.error(`[waker-selfedit] 已为 ${WAKER_ID} 注册 waker_self_edit（档案目录 ${AGENT_DIR}）`);

  pi.registerTool({
    name: 'waker_self_edit',
    label: '修改自己的档案',
    description:
      '读取或修改你自己的档案文件（SOUL.md / identity.md / persona.md / bible.md / MEMORY.md）。' +
      '改不了权限配置文件 waker.yaml。写入前平台会自动备份旧版本，改动下一次对话生效。',
    promptSnippet: '想调整自己的人设/风格/红线时，用 waker_self_edit 改自己的档案',
    promptGuidelines: [
      '只有在确认要长期改变自己的行为方式时才改档案，不要为了给某次回答找补就改人设。',
      'write 必须写清 reason（它会被记进审计流水，给人看）。',
      '改完要明确告诉用户"下一次对话生效"，不要谎称当前这轮已经变了。',
    ],
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list 看档案清单 / read 读某一份 / write 写回某一份' },
        file: { type: 'string', description: `要读写的文件名，可选：${EDITABLE.join(' / ')}` },
        content: { type: 'string', description: 'write 时的完整新内容（整份覆盖，不是追加）' },
        reason: { type: 'string', description: 'write 时的改动理由，写具体一点（进审计流水）' },
      },
      required: ['action'],
    },
    execute: async (
      _id: string,
      params: { action?: string; file?: string; content?: string; reason?: string },
    ) => {
      const action = (params?.action ?? '').trim();
      const file = (params?.file ?? '').trim();

      if (action === 'list') {
        const rows = EDITABLE.map((name) => readState(name));
        const lines = rows.map((r) =>
          r.exists
            ? `- ${r.name}：${r.bytes} 字节，最后修改 ${r.updatedAt?.slice(0, 19).replace('T', ' ')}`
            : `- ${r.name}：（还没有内容）`,
        );
        return ok(
          [
            `你的档案目录：${AGENT_DIR}`,
            '',
            ...lines,
            '',
            `备份目录：${HISTORY_DIR}`,
            '想看某一份的全文用 action=read；要改就 action=write（整份覆盖，写前自动备份）。',
            '注意：权限配置 waker.yaml 不能改，那不在你的档案范围内。',
          ].join('\n'),
        );
      }

      if (!(EDITABLE as readonly string[]).includes(file)) {
        return ok(
          `只能操作这五份档案：${EDITABLE.join(' / ')}。` +
            (file === 'waker.yaml'
              ? '\n（waker.yaml 是权限配置，故意不开放：你能改自己的样子，但不能给自己扩权。）'
              : `\n你给的是：${file || '(空)'}`),
        );
      }

      if (action === 'read') {
        const st = readState(file);
        if (!st.exists) return ok(`${file} 目前是空的（文件不存在）。`);
        const clipped = st.content.length > MAX_READ_CHARS;
        return ok(
          `${file}（${st.bytes} 字节${st.updatedAt ? `，最后修改 ${st.updatedAt.slice(0, 19).replace('T', ' ')}` : ''}）：\n\n` +
            `${clipped ? st.content.slice(0, MAX_READ_CHARS) : st.content}` +
            (clipped ? `\n\n…（原文更长，这里只给前 ${MAX_READ_CHARS} 字符）` : ''),
        );
      }

      if (action === 'write') {
        const content = params?.content;
        const reason = (params?.reason ?? '').trim();
        if (typeof content !== 'string') return ok('write 需要提供 content（完整的新内容）。');
        if (!reason) return ok('write 需要提供 reason：说明为什么要改自己的档案。');
        if (content.length > MAX_WRITE_CHARS) {
          return ok(`内容太长（${content.length} 字符 > 上限 ${MAX_WRITE_CHARS}），请精简后再写。`);
        }

        const before = readState(file);
        if (before.exists && before.content === content) {
          return ok(`${file} 内容没有变化，未做任何写入。`);
        }

        try {
          const backupPath = backup(before);
          writeFileSync(join(AGENT_DIR, file), content, 'utf-8');
          audit({
            at: new Date().toISOString(),
            wakerId: WAKER_ID,
            file,
            bytesBefore: before.bytes,
            bytesAfter: Buffer.byteLength(content, 'utf-8'),
            created: !before.exists,
            reason,
            backup: backupPath,
            pid: process.pid,
          });
          return ok(
            [
              `已写入 ${file}：${before.exists ? `${before.bytes} → ${Buffer.byteLength(content, 'utf-8')} 字节` : `${Buffer.byteLength(content, 'utf-8')} 字节（新建）`}`,
              backupPath ? `旧版本已备份：${backupPath}` : '（此前没有内容，无需备份）',
              '本次改动已记入审计流水（data/selfedit.jsonl）。',
              '',
              '**下一次对话才生效**：你的身份是在启动时装载的，这一轮你仍是按旧档案说话。',
              '请在回复里如实告诉用户这一点。',
            ].join('\n'),
          );
        } catch (e) {
          return ok(`写入失败：${(e as Error)?.message ?? e}`);
        }
      }

      return ok(`未知 action：${action || '(空)'}。可用：list / read / write。`);
    },
  });
}
