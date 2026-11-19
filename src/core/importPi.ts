import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WakerRecord } from '../types.ts';
import { AGENTS_DIR, PI_AGENTS_DIR, PLATFORM_ROOT, agentDir, safeId } from './paths.ts';
import { listPiProfiles, loadPiProfile } from './piProfiles.ts';
import { loadWaker } from './registry.ts';
import { writeCompiledArtifacts } from './identity.ts';

/**
 * 把本机 Pi agent **导入**成平台员工（`waker import`）。
 *
 * 与"只读纳管"的区别是根本性的：
 * - 纳管：Pi profile 还是本体，平台只是读它；名称/岗位/模型/策略由 frontmatter 决定，平台不能归档；
 * - 导入：在 `agents/<id>/` 生成**完整五件套**，从此本体是平台档案 —— 能改策略、能收紧权限、
 *   能纳入 git、能归档。Pi 侧文件**保留不删**（同名时本地优先，所以那份自动隐去，想回退删本地目录即可）。
 *
 * 映射规则（frontmatter → 平台字段）：
 *   description → role ／ display_name → name ／ model → model ／ tools → policy.toolAllow
 *   inherit_context / run_in_background 在平台侧没有等价物，忽略。
 *
 * 正文**整体**进 SOUL.md，不自动拆分：拆"我是谁 / 工作风格 / 红线"要读懂内容，
 * 机器硬拆只会拆错；identity / persona / bible 生成占位并在注释里指向 SOUL，
 * 由人按需搬段落（搬的时候记得从 SOUL 删掉，否则两处都写会重复注入）。
 */
export interface ImportPiResult {
  rec: WakerRecord;
  /** 是否复用了一个已存在的空档案目录（正常情况下不会）。 */
  dir: string;
}

/** 可导入的本机 agent 清单（含"已导入"标记），供 CLI 与看板列用。 */
export interface PiAgentBrief {
  id: string;
  name: string;
  role: string;
  model: string;
  tools: string[];
  enabled: boolean;
  /** 源文件绝对路径。 */
  file: string;
  /** 平台侧是否已有同名档案（已有则不能再导入）。 */
  imported: boolean;
}

export function listImportablePiAgents(): PiAgentBrief[] {
  return listPiProfiles().map((p) => ({
    id: p.id,
    name: p.displayName,
    role: p.description,
    model: p.model,
    tools: p.tools,
    enabled: p.enabled,
    file: p.file,
    imported: existsSync(agentDir(p.id)),
  }));
}

function yamlEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 生成 waker.yaml：注释里留全来源与回退办法，否则三个月后没人知道这档案哪来的。 */
function yamlFor(
  p: { id: string; name: string; role: string; model: string; tools: string[]; file: string },
  cwd: string,
): string {
  const tools = p.tools.length ? `[${p.tools.map((t) => `"${yamlEscape(t)}"`).join(', ')}]` : '[]';
  return `# ${p.id} 的岗位定义
#
# 由 \`waker import\` 从本机 Pi agent 导入（${new Date().toISOString().slice(0, 10)}）。
# 源文件：${p.file} —— **保留不删**；同名时平台档案优先，那份自动隐去。
# 想回退：删掉本目录，Pi 版立刻回来（\`waker agent inspect ${p.id}\` 会重新显示为 Pi 来源）。
#
# 导入映射：description→role、display_name→name、model→model、tools→policy.toolAllow
# inherit_context / run_in_background 在平台侧没有等价物，已忽略。
name: "${yamlEscape(p.name)}"
role: "${yamlEscape(p.role)}"
model: "${yamlEscape(p.model)}"
cwd: "${yamlEscape(cwd)}"
enabled: true

policy:
  sandbox: false
  # 复刻 Pi 侧声明的工具集（空数组=不限制）
  toolAllow: ${tools}
  # 导入时**不设命令白名单**（Pi 侧也没有），只沿用平台默认黑名单 ——
  # 设白名单要先确认这个 agent 的工作流需要哪些命令，随手写会把它的能力废掉。
  # 确认过之后可以在这里收紧，例如只留读写与检索：
  #   commandAllow: ["ls", "cat", "grep", "find", "head", "tail", "wc", "git", "mkdir"]
  pathDeny: [".ssh", ".aws", ".npmrc", ".netrc", "id_rsa", ".pypirc", ".docker/config.json", "secrets.json"]
  requireConfirm: ["删除文件", "推送到远程", "发布", "对外发送"]
  commandTimeoutMs: 600000
`;
}

/**
 * 导入本机 Pi agent。若平台已有同名档案则报错（不静默覆盖——
 * 覆盖会吞掉用户对那份档案的改动，宁可让人先归档）。
 */
export function importPiWaker(piId: string, opts: { cwd?: string } = {}): ImportPiResult {
  const id = safeId(piId);
  const p = loadPiProfile(id);
  if (!p) throw new Error(`本机没有这个 agent：${piId}（目录 ${PI_AGENTS_DIR}）`);

  const dir = agentDir(id);
  if (existsSync(dir)) {
    throw new Error(`平台已有同名档案：${dir}；要重新导入请先在看板归档它（或手动移走目录）`);
  }

  const cwd = opts.cwd?.trim() || PLATFORM_ROOT;
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, 'waker.yaml'),
    yamlFor({ id, name: p.displayName, role: p.description, model: p.model, tools: p.tools, file: p.file }, cwd),
    'utf-8',
  );

  // 正文整体进 SOUL：不硬拆，避免拆错；来源与拆法提示写在开头
  writeFileSync(
    join(dir, 'SOUL.md'),
    `# 人设总纲（SOUL）

> 导入自 ${p.file}（正文原样，未删减）。
> identity / persona / bible 是占位——需要拆分时把这里的段落搬过去，**并从本文件删掉**，
> 两处都写会在提示词里重复注入。

${p.body}
`,
    'utf-8',
  );

  writeFileSync(
    join(dir, 'identity.md'),
    `# 我是谁

（占位：完整人设见 SOUL.md。）

服务对象：平台使用者。

主要职责：
- ${p.description}
`,
    'utf-8',
  );

  writeFileSync(
    join(dir, 'persona.md'),
    `# 工作风格

（占位：完整人设见 SOUL.md。）

- 结论先行，先给结果再给依据
- 不确定时明确说"未确认"，不为了让回答显得完整而编造
`,
    'utf-8',
  );

  writeFileSync(
    join(dir, 'bible.md'),
    `# 红线

- 不得删除工作目录之外的任何文件
- 不得推送代码到远程分支
- 涉及发布、付款、外发必须先取得人工确认
`,
    'utf-8',
  );

  writeFileSync(join(dir, 'MEMORY.md'), `# 长期记忆\n\n（由人工或复盘补充，本文件纳入 git 版本化）\n`, 'utf-8');

  // 立即编译：扩展读不到策略会 fail-open，所以创建路径必须编译（与 createWaker 一致）
  const rec = loadWaker(id);
  if (!rec) throw new Error(`档案写入后无法读回，请检查目录权限：${dir}`);
  writeCompiledArtifacts(rec);
  return { rec, dir };
}

/** 导入后给用户的提示（CLI 与网关共用措辞，避免两处说法不一致）。 */
export function importTips(rec: WakerRecord): string[] {
  return [
    `档案目录：${AGENTS_DIR}/${rec.def.id}`,
    `Pi 侧源文件保留未动；想回退就删掉上面的目录，Pi 版立刻回来`,
    `人设正文整体在 SOUL.md；要拆 identity / persona / bible 时记得从 SOUL 删掉对应段落`,
    `策略：工具集复刻自 Pi，命令白名单未设（与 Pi 一致）；要收紧就改 waker.yaml 的 policy.commandAllow`,
    `记忆不跟随：它的私有记忆从零开始（要补：见 vendor/multi-pi-memory/README.md「把记忆复制到另一个 waker id 名下」）`,
  ];
}

/** 供 CLI 打印的可读行长（避免各处重复拼字符串）。 */
export function importLine(b: PiAgentBrief): string {
  const flag = b.imported ? '已导入' : b.enabled ? '可导入' : '已停用';
  return `${b.id.padEnd(20)} ${b.name.padEnd(14)} ${flag.padEnd(6)} ${b.model.padEnd(30)} ${b.role}`;
}
