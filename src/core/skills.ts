import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DATA_DIR, PI_AGENT_HOME, safeId } from './paths.ts';

/** 一个技能的元信息（名称 + 来自 SKILL.md frontmatter 的描述）。 */
export interface SkillInfo {
  name: string;
  description: string;
}

/** Pi 的技能库目录。 */
export const SKILLS_DIR = join(PI_AGENT_HOME, 'skills');

/** 每个员工勾选的技能存平台侧 `data/skills/<id>.json`。 */
const SKILL_CONFIG_DIR = join(DATA_DIR, 'skills');

function skillConfigPath(id: string): string {
  return join(SKILL_CONFIG_DIR, `${safeId(id)}.json`);
}

/** 读取某个技能 SKILL.md frontmatter 里的 description。 */
function readSkillDescription(name: string): string {
  const p = join(SKILLS_DIR, name, 'SKILL.md');
  if (!existsSync(p)) return '';
  try {
    const m = readFileSync(p, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return '';
    const data = parseYaml(m[1] ?? '') as { description?: unknown };
    return typeof data?.description === 'string' ? data.description.trim() : '';
  } catch {
    return '';
  }
}

/** 列出本机全部可用技能（含描述），供看板勾选时查看。 */
export function listSkills(): SkillInfo[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR)
    .filter((n) => !n.startsWith('.'))
    .sort()
    .map((name) => ({ name, description: readSkillDescription(name) }));
}

/**
 * 该员工勾选的技能。
 * 返回 `null` 表示"未配置"——此时沿用 pi 的默认技能发现，不改变既有行为。
 */
export function getEnabledSkills(id: string): string[] | null {
  const p = skillConfigPath(id);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8')) as { enabled?: unknown };
    return Array.isArray(data.enabled) ? (data.enabled.filter((x): x is string => typeof x === 'string')) : null;
  } catch {
    return null;
  }
}

/** 写入该员工勾选的技能。 */
export function setEnabledSkills(id: string, enabled: string[]): void {
  if (!existsSync(SKILL_CONFIG_DIR)) mkdirSync(SKILL_CONFIG_DIR, { recursive: true });
  writeFileSync(skillConfigPath(id), `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf-8');
}

/** 技能目录的绝对路径（供 runner 显式 --skill 使用）。 */
export function skillDir(name: string): string {
  return join(SKILLS_DIR, name);
}
