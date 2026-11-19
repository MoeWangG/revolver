import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { writeCompiledArtifacts } from './identity.ts';
import { agentDir } from './paths.ts';
import { loadWaker } from './registry.ts';

/**
 * 员工基本信息（`agents/<id>/waker.yaml` 的头部字段）。
 *
 * 改名/改岗位只动这几个字段：用 yaml 的 Document API 原地改键，
 * **保留原文件的注释与排版**，而不是整体重新序列化。
 */

export interface WakerProfile {
  id: string;
  name: string;
  role: string;
  model: string;
  cwd: string;
  enabled: boolean;
  /** local = 平台内档案；pi = 纳管的 Pi profile（只读）。 */
  origin: 'local' | 'pi';
  /** 是否可编辑。 */
  editable: boolean;
}

export interface ProfilePatch {
  name?: string;
  role?: string;
  model?: string;
  /** 工作目录。改动等于换文件系统边界，必须是已存在的绝对路径。 */
  cwd?: string;
}

/** 读取员工信息。纳管的 Pi profile 由其 frontmatter 映射而来，只读。 */
export function readProfile(id: string): WakerProfile | null {
  const rec = loadWaker(id);
  if (!rec) return null;
  const origin = rec.def.origin ?? 'local';
  return {
    id: rec.def.id,
    name: rec.def.name,
    role: rec.def.role,
    model: rec.def.model,
    cwd: rec.def.cwd,
    enabled: rec.def.enabled,
    origin,
    editable: origin !== 'pi',
  };
}

/** 更新名称 / 岗位 / 模型。返回更新后的信息。 */
export function updateProfile(id: string, patch: ProfilePatch): WakerProfile {
  const rec = loadWaker(id);
  if (!rec) throw new Error(`未找到员工：${id}`);
  if ((rec.def.origin ?? 'local') === 'pi') {
    throw new Error(`「${id}」纳管自 Pi 的 agent profile，请到 Pi 侧修改名称`);
  }

  const file = join(agentDir(id), 'waker.yaml');
  if (!existsSync(file)) throw new Error(`找不到档案文件：${file}`);

  const doc = parseDocument(readFileSync(file, 'utf-8'));
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('名称不能为空');
    doc.set('name', name);
  }
  if (patch.role !== undefined) doc.set('role', patch.role.trim());
  if (patch.model !== undefined) doc.set('model', patch.model.trim() || 'auto');

  // —— 工作目录 ——
  // 为什么单独校验：cwd 同时是三件事，改错代价都不小。
  //   1. pi 子进程的 spawn 目录；
  //   2. guard 的文件系统边界（`pathAllow` 通常以它为基准）；
  //   3. **pi 会话目录的来源** —— pi 按 cwd 生成 slug 目录（`--Users-you-project--`），
  //      换 cwd 等于换了一个会话仓库，历史会话仍留在旧目录里（不会丢，但列表里看不到）。
  // 所以这里要求"绝对路径 + 目录已存在"，把错字挡在写入之前。
  if (patch.cwd !== undefined && patch.cwd.trim() !== rec.def.cwd) {
    const next = patch.cwd.trim();
    if (!next) throw new Error('工作目录不能为空');
    if (!next.startsWith('/')) throw new Error(`工作目录必须是绝对路径：${next}`);
    if (!existsSync(next)) throw new Error(`目录不存在：${next}（先创建它，再改这里）`);
    doc.set('cwd', next);
  }

  writeFileSync(file, doc.toString(), 'utf-8');

  const next = readProfile(id);
  if (!next) throw new Error('更新后无法重新读取档案');
  return next;
}

// ——————————————————————————————————————————————————————————————
// 权限（可读写目录范围 + 档案自改开关）
// ——————————————————————————————————————————————————————————————

/**
 * 权限视图。给看板编辑用，取的是**生效值**（`registry` 解析后的结果），
 * 不是 yaml 原文——这样界面上看到的就是 guard 真正在用的那几条。
 */
export interface AgentPermissions {
  id: string;
  /** Pi 纳管的 profile 只读。 */
  editable: boolean;
  /** 可读写目录白名单（绝对路径）。**空 = 不限制**。 */
  pathAllow: string[];
  /** 保护路径片段。空 = 除内置保护外不再额外拦。 */
  pathDeny: string[];
  /** 是否允许该员工修改自己的档案。 */
  selfEdit: boolean;
  /** 是否允许该员工操作浏览器（browser 工具，经常驻 broker）。 */
  browser: boolean;
  /** 工作目录：相对路径的解析基准，也是"pathAllow 没覆盖它"这类提醒的判据。 */
  cwd: string;
}

export interface PermissionsPatch {
  pathAllow?: string[];
  pathDeny?: string[];
  selfEdit?: boolean;
  browser?: boolean;
}

export function readPermissions(id: string): AgentPermissions | null {
  const rec = loadWaker(id);
  if (!rec) return null;
  const p = rec.def.policy;
  return {
    id: rec.def.id,
    editable: (rec.def.origin ?? 'local') !== 'pi',
    pathAllow: p.pathAllow ?? [],
    pathDeny: p.pathDeny ?? [],
    selfEdit: p.selfEdit === true,
    browser: p.browser === true,
    cwd: rec.def.cwd,
  };
}

/** 目录白名单条目：必须是绝对路径。相对路径会被 guard 按 cwd 解析，写错方向反而更危险。 */
function normalizeAllow(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const v = String(raw ?? '').trim();
    if (!v) continue;
    if (!v.startsWith('/')) {
      throw new Error(`目录白名单只接受绝对路径（guard 会把相对路径按工作目录解析，容易理解错）：${v}`);
    }
    // 去掉末尾斜杠，但保留根目录本身
    const norm = v.length > 1 ? v.replace(/\/+$/, '') : v;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/** 保护片段：允许 `.ssh` / `.env` 这种片段写法（guard 用的是包含匹配），只清空值。 */
function normalizeDeny(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const v = String(raw ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 改权限。写入用 yaml 的 Document API **原地改键**，保留文件里的注释与排版
 * （照抄 `updateProfile` 的做法——`parse` + `stringify` 会把整个文件重排）。
 *
 * 写完必须**立刻重新编译**：guard 读的是 `data/policy/<id>.policy.json`，
 * 不重编译的话改了界面上看着变了、实际门禁还是老规则，比不能改更糟。
 */
export function updatePermissions(id: string, patch: PermissionsPatch): AgentPermissions {
  const rec = loadWaker(id);
  if (!rec) throw new Error(`未找到员工：${id}`);
  if ((rec.def.origin ?? 'local') === 'pi') {
    throw new Error(`「${id}」纳管自 Pi 的 agent profile，权限请到 Pi 侧修改`);
  }

  const file = join(agentDir(id), 'waker.yaml');
  if (!existsSync(file)) throw new Error(`找不到档案文件：${file}`);
  const doc = parseDocument(readFileSync(file, 'utf-8'));

  // 运行时也校验一遍类型：HTTP 来的 body 是 `unknown`，
  // 若把字符串当数组传进来，`for...of` 会逐字符迭代（把 "/tmp" 拆成 4 条白名单）。
  const arr = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v)) throw new Error(`${field} 应为字符串数组`);
    return v.map((x) => String(x ?? ''));
  };

  if (patch.pathAllow !== undefined) doc.setIn(['policy', 'pathAllow'], normalizeAllow(arr(patch.pathAllow, 'pathAllow')));
  if (patch.pathDeny !== undefined) doc.setIn(['policy', 'pathDeny'], normalizeDeny(arr(patch.pathDeny, 'pathDeny')));
  if (patch.selfEdit !== undefined) doc.setIn(['policy', 'selfEdit'], patch.selfEdit === true);
  if (patch.browser !== undefined) doc.setIn(['policy', 'browser'], patch.browser === true);

  writeFileSync(file, doc.toString(), 'utf-8');

  const fresh = loadWaker(id);
  if (!fresh) throw new Error('写入后无法重新读取档案');
  writeCompiledArtifacts(fresh);

  const next = readPermissions(id);
  if (!next) throw new Error('写入后无法重新读取权限');
  return next;
}

/** 保存后要提醒人的副作用（都是"看着没事、其实有事"的那种）。 */
export function permissionWarnings(before: AgentPermissions, after: AgentPermissions): string[] {
  const w: string[] = [];

  const allowChanged = JSON.stringify(before.pathAllow) !== JSON.stringify(after.pathAllow);
  if (allowChanged) {
    if (!after.pathAllow.length) {
      w.push('目录白名单已清空：**等于不限制**，该员工可读写整个文件系统（只受保护名单约束）。');
    } else {
      const coversCwd = after.pathAllow.some((d) => after.cwd === d || after.cwd.startsWith(`${d}/`));
      if (!coversCwd) {
        w.push(`目录白名单不包含它的工作目录 ${after.cwd} —— 它连自己目录里的文件都读不了，确认是有意的。`);
      }
      const missing = after.pathAllow.filter((d) => !existsSync(d));
      if (missing.length) w.push(`这些目录当前不存在：${missing.join('、')}（不影响保存，但确认下是否写错）。`);
      w.push('改动已重新编译，**下一个任务/下一轮对话即生效**（bash 命令本身仍不受目录白名单约束）。');
    }
  }

  if (JSON.stringify(before.pathDeny) !== JSON.stringify(after.pathDeny) && !after.pathDeny.length) {
    w.push('保护名单已清空：`.ssh` / `.env` 这类凭据不再被拦（read 与 bash 都是）。');
  }

  if (!before.selfEdit && after.selfEdit) {
    w.push('已开启档案自改：它下次对话起可改自己的 SOUL/身份/风格/红线/长期记忆（写前自动备份、每次留痕，改不了 waker.yaml）。');
  } else if (before.selfEdit && !after.selfEdit) {
    w.push('已关闭档案自改：waker_self_edit 工具不再提供。');
  }

  if (!before.browser && after.browser) {
    w.push(
      '已开启浏览器能力：它下个任务起拿到 browser 工具（参数是多行命令 DSL）。broker **不用手动起**——首次调用连不上时会自己拉起' +
        '（日志 data/browser-broker.log）。Chrome 侧只要浏览器开着、Browser MCP 扩展在启用状态即可' +
        '（2.x 的扩展连常驻 daemon 127.0.0.1:9010，不再需要点 Connect），' +
        '否则调用会明确报"浏览器未连接"。浏览器是单标签页、操作不可逆，建议保留 requireConfirm。',
    );
  } else if (before.browser && !after.browser) {
    w.push('已关闭浏览器能力：browser 工具不再提供（broker 仍可服务其他员工）。');
  }

  return w;
}
