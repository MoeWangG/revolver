import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PI_AGENTS_DIR, safeId } from './paths.ts';

/**
 * Pi 本地 agent / subagent profile。
 *
 * 与 Waker 的目录式档案（`agents/<id>/` 五件套）不同，Pi 生态里一个 agent 就是
 * 一个带 YAML frontmatter 的 Markdown 文件：`~/.pi/agent/agents/<name>.md`。
 * 本模块只做「读取纳管」，不改动 Pi 侧的既有资产。
 */
export interface PiProfile {
  /** 规范化的员工 id（文件名去扩展名，经 safeId）。 */
  id: string;
  /** profile 文件绝对路径。 */
  file: string;
  /** 岗位描述（frontmatter.description）。 */
  description: string;
  /** 显示名（frontmatter.display_name，缺省回退到 id）。 */
  displayName: string;
  /** 模型标识（frontmatter.model，缺省 auto）。 */
  model: string;
  /** 允许的工具（frontmatter.tools，兼容字符串与数组两种写法）。 */
  tools: string[];
  /** 是否启用（frontmatter.enabled !== false）。 */
  enabled: boolean;
  /** 是否继承上下文（subagent 特征）。 */
  inheritContext: boolean;
  /** 是否后台运行（subagent 特征）。 */
  runInBackground: boolean;
  /** 正文（已剥离 frontmatter）。 */
  body: string;
  /** 原始文件内容。 */
  raw: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 拆分 frontmatter 与正文。无 frontmatter 时 data 为空对象、body 为原文。 */
export function splitFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { data: {}, body: raw.trim() };
  let data: Record<string, unknown> = {};
  try {
    data = (parseYaml(m[1] ?? '') ?? {}) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { data, body: raw.slice(m[0].length).trim() };
}

/** tools 字段兼容 `"read, bash, edit"` 字符串与 `["read","bash"]` 数组。 */
function asTools(v: unknown): string[] {
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/** 列出全部 Pi profile 的规范化 id。 */
export function listPiProfileIds(): string[] {
  if (!existsSync(PI_AGENTS_DIR)) return [];
  return readdirSync(PI_AGENTS_DIR)
    .filter((n) => n.endsWith('.md'))
    .map((n) => safeId(basename(n, '.md')))
    .sort();
}

/** 加载单个 Pi profile。id 经过 safeId，可能与文件名大小写不同，故按规范 id 反查目录。 */
export function loadPiProfile(id: string): PiProfile | null {
  if (!existsSync(PI_AGENTS_DIR)) return null;
  for (const n of readdirSync(PI_AGENTS_DIR)) {
    if (!n.endsWith('.md')) continue;
    if (safeId(basename(n, '.md')) !== id) continue;

    const file = join(PI_AGENTS_DIR, n);
    let raw = '';
    try {
      raw = readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
    const { data, body } = splitFrontmatter(raw);
    return {
      id,
      file,
      description: asString(data.description, '未描述岗位'),
      displayName: asString(data.display_name, id),
      model: asString(data.model, 'auto'),
      tools: asTools(data.tools),
      enabled: data.enabled !== false,
      inheritContext: data.inherit_context === true,
      runInBackground: data.run_in_background === true,
      body,
      raw,
    };
  }
  return null;
}

/** 加载全部 Pi profile。 */
export function listPiProfiles(): PiProfile[] {
  return listPiProfileIds()
    .map((id) => loadPiProfile(id))
    .filter((p): p is PiProfile => p !== null);
}

/**
 * 只替换 profile 的**正文**，frontmatter（description/model/tools 等配置）原样保留。
 * 供看板编辑 Pi agent 的人设（prompt）时使用。
 */
export function writePiProfileBody(id: string, body: string): boolean {
  const p = loadPiProfile(id);
  if (!p) return false;
  const m = p.raw.match(FRONTMATTER_RE);
  const head = m ? m[0] : '';
  const tail = body.endsWith('\n') ? body : `${body}\n`;
  writeFileSync(p.file, `${head}${tail}`, 'utf-8');
  return true;
}
