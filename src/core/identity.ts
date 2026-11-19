import { writeFileSync } from 'node:fs';
import type { CompiledPolicy, WakerDef, WakerPolicy, WakerRecord } from '../types.ts';
import { agentDir, policyFile, POLICY_DIR } from './paths.ts';
import { readRoleFile } from './registry.ts';
import { hasAvatar } from './avatars.ts';

/**
 * 剥离正文开头的 Markdown 标题。
 *
 * 档案文件通常自带 `# 我是谁` 之类的标题，而装配时外壳会统一加分区标题，
 * 直接拼接会出现双层标题（"## 我是谁 / # 我是谁"）。这里只剥首个标题行，
 * 正文内部的小节标题保留——它们是有意义的结构。
 */
function stripLeadingHeading(md: string): string {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i += 1;
  if (i < lines.length && /^#{1,6}\s/.test(lines[i]!.trim())) lines.splice(i, 1);
  return lines.join('\n').trim();
}

/**
 * 把档案三件套装配成一段可注入的系统提示。
 *
 * 关键取舍：**这段文本在外壳侧生成，不在 Extension 运行时拼接。**
 * 因为 before_agent_start 的 handler 是串行 await 的（见 pi-web-extensions 事故复盘），
 * Extension 侧读磁盘会拖慢整个 agent 启动。
 */
export function buildSystemPrompt(rec: WakerRecord): string {
  const { def } = rec;
  const blocks: string[] = [];

  blocks.push(
    [
      '## 岗位身份',
      '',
      `你是「${def.name}」，岗位是${def.role}。`,
      `你的工作目录是 \`${def.cwd}\`，这是你的文件系统边界，不要越出该目录操作无关文件。`,
    ].join('\n'),
  );

  // SOUL 是"人设总纲"，排在职责之前：先定义它是个什么样的存在，再说它负责什么
  const soul = stripLeadingHeading(readRoleFile(rec, 'soul'));
  if (soul) blocks.push(`## 人设总纲（SOUL）\n\n${soul}`);

  const identity = stripLeadingHeading(readRoleFile(rec, 'identity'));
  if (identity) blocks.push(`## 我是谁\n\n${identity}`);

  const persona = stripLeadingHeading(readRoleFile(rec, 'persona'));
  if (persona) blocks.push(`## 工作风格\n\n${persona}`);

  const bible = stripLeadingHeading(readRoleFile(rec, 'bible'));
  if (bible) blocks.push(`## 红线与边界\n\n${bible}`);

  blocks.push(buildBoundarySection(def));

  if (def.extraPrompt) blocks.push(`## 附加约定\n\n${def.extraPrompt}`);

  return blocks.join('\n\n');
}

/** 由策略推导出的机器可读边界，让模型在动手前就知道会被拦截。 */
function buildBoundarySection(def: WakerDef): string {
  const p = def.policy;
  const lines: string[] = ['## 执行约束（机器强制）', ''];

  if (p.commandAllow?.length) {
    lines.push(`允许执行的命令前缀：${p.commandAllow.map((c) => `\`${c}\``).join('、')}。`);
    lines.push('不在该列表内的命令会被直接拦截，不要反复尝试。');
  }
  if (p.commandDeny?.length) {
    lines.push(`明确禁止的命令片段：${p.commandDeny.map((c) => `\`${c}\``).join('、')}。`);
  }
  if (p.pathAllow?.length) {
    lines.push(`可读写目录：${p.pathAllow.map((c) => `\`${c}\``).join('、')}。`);
  }
  if (p.pathDeny?.length) {
    lines.push(`禁止触碰的路径：${p.pathDeny.map((c) => `\`${c}\``).join('、')}（含凭据文件）。`);
  }
  if (p.requireConfirm?.length) {
    lines.push('', '以下动作需要先取得人工确认，不要擅自执行：');
    for (const c of p.requireConfirm) lines.push(`- ${c}`);
  }
  if (p.sandbox) {
    lines.push('', `所有 bash 命令运行在 Docker 容器 \`${p.sandboxImage ?? 'alpine:3.20'}\` 中，`);
    lines.push(p.sandboxNetwork ? '容器允许外网访问。' : '容器无外网访问，任何联网操作都会失败，不要重试。');
  }

  if (p.selfEdit) lines.push('', ...selfEditSection(def));

  return lines.join('\n');
}

/**
 * 「你可以改自己」这一段。
 *
 * 只在 `policy.selfEdit` 打开时注入，且**必须写清三件事**，否则员工只能靠猜：
 * 档案在哪（绝对路径）、怎么改（工具名与动作）、改了什么时候生效。
 * 还要显式说明"改不了权限"——不然它会反复尝试写 waker.yaml，白耗几轮。
 *
 * 纳管的 Pi profile 没有 `agents/<id>/` 目录（人设就是 profile 正文一个文件），
 * 这里不注入，避免给出一条它走不通的路径。
 */
function selfEditSection(def: WakerDef): string[] {
  if ((def.origin ?? 'local') === 'pi') return [];
  const dir = agentDir(def.id);
  return [
    '## 你可以修改自己的档案（已开启）',
    '',
    `你的档案目录是 \`${dir}\`，其中这五份是**你自己的文本，你可以改**：`,
    '`SOUL.md`（人设总纲）、`identity.md`（我是谁）、`persona.md`（工作风格）、`bible.md`（红线）、`MEMORY.md`（长期记忆）。',
    '',
    '修改方式：用 `waker_self_edit` 工具（`list` 看清单、`read` 读原文、`write` 写回）。',
    '不要绕过它去直接读写这些文件——直接写不会留下备份与留痕。',
    '',
    '- `write` 需要给 `file`、`content`、`reason`；写入前平台会**自动备份**旧版本，事后可回滚。',
    '- **改不了 `waker.yaml`**：权限（工具/命令/目录白名单、沙箱、本开关）不在可改范围内。',
    '  想扩权请向人提出，不要尝试用别的写法绕。',
    '- 改动**下一次对话才生效**：身份是在你启动时装载的，这一轮你仍是按旧档案说话。',
    '- 只在自己确实想清楚了才动手，并把 `reason` 写具体（它是给人看的审计记录）。',
  ];
}

/** 编译策略，供 guard 扩展消费。Extension 侧只读 JSON，不解析 YAML。 */
export function compilePolicy(rec: WakerRecord): CompiledPolicy {
  const { def } = rec;
  return {
    ...def.policy,
    wakerId: def.id,
    wakerName: def.name,
    cwd: def.cwd,
    compiledAt: new Date().toISOString(),
  };
}

/** 注入文本落盘路径。 */
export function promptFile(id: string): string {
  return `${POLICY_DIR.replace(/\/$/, '')}/${id}.prompt.md`;
}

/**
 * 写出员工运行期所需的两份产物：策略 JSON 与注入文本。
 * Runner 拉起 pi 前必须调用，否则 Extension 会因缺少策略而放行一切（fail-open 不可接受）。
 */
export function writeCompiledArtifacts(rec: WakerRecord): { policyPath: string; promptPath: string } {
  const policyPath = policyFile(rec.def.id);
  const promptPath = promptFile(rec.def.id);
  writeFileSync(policyPath, `${JSON.stringify(compilePolicy(rec), null, 2)}\n`, 'utf-8');
  writeFileSync(promptPath, buildSystemPrompt(rec), 'utf-8');
  return { policyPath, promptPath };
}

/** 供 CLI inspect 用的摘要，避免打印整份提示词。 */
export function describeWaker(rec: WakerRecord): Record<string, unknown> {
  const d: WakerDef = rec.def;
  return {
    id: d.id,
    name: d.name,
    role: d.role,
    model: d.model,
    cwd: d.cwd,
    enabled: d.enabled,
    origin: d.origin ?? 'local',
    // 密钥只暴露"是否已配置"，不返回明文
    llm: d.llm
      ? {
          provider: d.llm.provider,
          model: d.llm.model,
          thinking: d.llm.thinking,
          hasApiKey: Boolean(d.llm.apiKey),
        }
      : undefined,
    channels: d.channels?.feishu
      ? {
          feishu: {
            enabled: d.channels.feishu.enabled,
            appId: d.channels.feishu.appId,
            hasAppSecret: Boolean(d.channels.feishu.appSecret),
            allowedUsers: d.channels.feishu.allowedUsers?.length ?? 0,
            allowedChats: d.channels.feishu.allowedChats?.length ?? 0,
          },
        }
      : undefined,
    sandbox: d.policy.sandbox,
    avatar: hasAvatar(d.id),
    hasIdentity: Boolean(rec.files.identity),
    hasPersona: Boolean(rec.files.persona),
    hasBible: Boolean(rec.files.bible),
    issues: rec.issues,
  };
}
