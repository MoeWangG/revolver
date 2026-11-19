import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WakerRecord } from '../types.ts';
import { ARCHIVE_DIR, AVATARS_DIR, CHANNELS_DIR, agentDir, policyFile, safeId } from './paths.ts';
import { loadWaker } from './registry.ts';
import { writeCompiledArtifacts, promptFile } from './identity.ts';
import { removeAvatar } from './avatars.ts';
import { dropWakerSessions } from './sessions.ts';

export interface CreateWakerInput {
  id: string;
  /** 岗位描述。缺省时写入占位内容，档案需要人工补全。 */
  role?: string;
  /** 工作目录，缺省用当前进程目录。 */
  cwd?: string;
  /** 展示名，缺省用 id。 */
  name?: string;
}

function yamlEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 创建员工档案并立即编译。
 *
 * 放在 core 是为了让 CLI 和 HTTP 网关共用同一份逻辑——
 * 否则两条创建路径迟早会分叉（比如一边编译一边不编译）。
 */
export function createWaker(input: CreateWakerInput): WakerRecord {
  const dir = agentDir(input.id);
  if (existsSync(dir)) throw new Error(`员工已存在：${input.id}`);

  const cwd = input.cwd?.trim() || process.cwd();
  const hasRole = Boolean(input.role?.trim());
  const role = hasRole ? input.role!.trim() : `${input.id}（岗位待补充）`;
  const name = input.name?.trim() || input.id;

  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, 'waker.yaml'),
    `# ${input.id} 的岗位定义
name: "${yamlEscape(name)}"
role: "${yamlEscape(role)}"
model: auto
cwd: "${yamlEscape(cwd)}"
enabled: true

# —— 该员工独立配置（可选，取消注释后生效）——
# llm:
#   provider: deepseek
#   model: deepseek-v4-pro
#   thinking: medium          # off/minimal/low/medium/high/xhigh/max
#   # apiKey 放同目录 secrets.json（已 gitignore）
# channels:
#   feishu:
#     enabled: true
#     appId: cli_xxxxxxxx
#     # appSecret 放同目录 secrets.json

policy:
  sandbox: false          # 改为 true 后 bash 全部走 Docker 容器
  # 白名单只检查命令首个 token，"cd X && …" 这种常见写法要求 cd 在名单里；
  # 名单过窄会逼模型不停换写法绕（实测连 echo/head 都被拦）。危险项交给下面的黑名单。
  commandAllow: ["ls", "cat", "head", "tail", "wc", "sort", "uniq", "grep", "find", "echo", "pwd", "cd", "mkdir", "touch", "cp", "git", "node", "npm", "pnpm", "python3"]
  # 黑名单片段**按词边界**匹配（不是裸子串）："rm " 不会误伤 "platform " / "form "
  commandDeny: ["rm ", "mv ", "sudo", "chmod", "chown"]
  pathAllow: ["${yamlEscape(cwd)}"]
  pathDeny: [".ssh", ".aws", ".env", "node_modules"]
  requireConfirm: ["删除文件", "推送到远程", "发布"]
  # 是否允许本员工修改自己的档案（SOUL / 身份 / 风格 / 红线 / 长期记忆）。
  # 开启后它会拿到 waker_self_edit 工具：改完写前自动备份到 data/identity-history/，
  # 每次修改留痕到 data/selfedit.jsonl。**权限不在可改之列**（改不了这份 waker.yaml），
  # 所以开了也不会自我扩权；改动下一次对话生效。
  selfEdit: false
  # 是否允许本员工操作浏览器（拿到 browser 工具，参数是一条多行命令 DSL）。
  # broker 不用手动起：首次调用连不上时会自己拉起（等价 waker browser start），日志在 data/browser-broker.log。
  # Chrome 侧只需装 Browser MCP 扩展（2.x 的扩展连常驻 daemon：127.0.0.1:9010，不用手点 Connect）。
  # 操作的是扩展所连的那个标签页（复用真实登录态），浏览器动作不可逆，按需开。
  # browser: false
`,
    'utf-8',
  );

  writeFileSync(
    join(dir, 'SOUL.md'),
    `# 人设总纲（SOUL）\n\n这是${name}最稳定的部分：不随任务变化的判断倾向与说话方式。\n\n## 判断倾向\n\n- 结论先行，再给证据\n- 不确定时明确说"未确认"，不为了让答案显得完整而编造\n- 准确性优先于完整性\n\n## 说话方式\n\n- 简洁直接，不堆砌客套与铺垫\n- 指出问题时同时给出位置或依据，便于核实\n\n## 底线\n\n- 被门禁拦截时不换写法绕过，而是说明原因并请人决策\n`,
    'utf-8',
  );

  writeFileSync(
    join(dir, 'identity.md'),
    hasRole
      ? `# 我是谁\n\n服务对象：平台使用者。\n\n主要职责：\n- ${role}\n`
      : `# 我是谁\n\n服务对象：\n主要职责：\n- （待补充：这个员工具体负责什么）\n`,
    'utf-8',
  );
  writeFileSync(join(dir, 'persona.md'), `# 工作风格\n\n先分析再执行；结论先行；不确定时明确指出。\n`, 'utf-8');
  writeFileSync(
    join(dir, 'bible.md'),
    `# 红线\n\n- 不得删除工作目录之外的任何文件\n- 不得推送代码到远程分支\n- 涉及发布、付款、外发必须先取得人工确认\n`,
    'utf-8',
  );
  writeFileSync(join(dir, 'MEMORY.md'), `# 长期记忆\n\n（由人工或复盘补充，本文件纳入 git 版本化）\n`, 'utf-8');

  // 立即编译：否则首次对话时扩展读不到策略会 fail-open
  const rec = loadWaker(input.id);
  if (!rec) throw new Error(`档案写入后无法读回，请检查目录权限：${dir}`);
  writeCompiledArtifacts(rec);
  return rec;
}

/**
 * 归档员工（"删除"按钮的真身）。
 *
 * 早先这里**只删编译产物**（policy/prompt 两个文件），档案目录原封不动 ——
 * 于是 `loadAllWakers()` 下次照样扫到它，用户点完删除发现"什么都没发生"。
 *
 * 现在做四件事，都要对得上"删除"这个承诺：
 *   1. 把 `agents/<id>/` **移动**到 `data/archived/<id>-<时间戳>/`（可恢复，不是真删）；
 *   2. 清掉它的编译产物、渠道配置（含密钥）、头像；
 *   3. 摘掉 `data/sessions.json` 里它的会话条目（否则留下孤儿会话）；
 *   4. **保留任务流水** —— 流水是不可变账本，删员工不该抹掉已发生的事实。
 */
export function archiveWaker(id: string): {
  archivedTo: string;
  removedFiles: string[];
  sessions: number;
} {
  const rec = loadWaker(id);
  if (!rec) throw new Error(`未找到员工：${id}`);
  // 纳管自 Pi 的 profile 不由本平台创建，也不应由本平台删除
  if (rec.origin === 'pi') throw new Error(`「${id}」纳管自 Pi profile，请到 Pi 侧维护，本平台不代为归档`);

  const dir = agentDir(id);
  if (!existsSync(dir)) throw new Error(`档案目录不存在：${dir}`);

  // 1) 移动档案目录（可恢复）
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivedTo = join(ARCHIVE_DIR, `${safeId(id)}-${stamp}`);
  renameSync(dir, archivedTo);

  // 2) 清理派生物
  const removed: string[] = [];
  for (const f of [
    policyFile(id),
    promptFile(id),
    join(CHANNELS_DIR, `${safeId(id)}.json`),
    join(CHANNELS_DIR, `${safeId(id)}.secret.json`),
  ]) {
    if (existsSync(f)) {
      rmSync(f, { force: true });
      removed.push(f);
    }
  }
  if (removeAvatar(id)) removed.push(join(AVATARS_DIR, `${safeId(id)}.png`));

  // 3) 摘掉会话条目（pi 原生会话文件保留在 ~/.pi 下，不越界删除）
  const sessions = dropWakerSessions(id);

  return { archivedTo, removedFiles: removed, sessions };
}
