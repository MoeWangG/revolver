import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDITABLE_FILES, type EditableFile } from '../types.ts';
import { agentDir } from './paths.ts';
import { loadWaker } from './registry.ts';
import { splitFrontmatter, writePiProfileBody } from './piProfiles.ts';
import { writeCompiledArtifacts } from './identity.ts';

/** 文件名白名单校验。任何不在白名单内的名字一律拒绝，杜绝路径穿越。 */
export function isEditable(name: string): name is EditableFile {
  return (EDITABLE_FILES as readonly string[]).includes(name);
}

export interface AgentFileView {
  name: EditableFile;
  path: string;
  exists: boolean;
  content: string;
  bytes: number;
  updatedAt: string | null;
}

function view(id: string, name: EditableFile): AgentFileView {
  const path = join(agentDir(id), name);
  const exists = existsSync(path);
  let content = '';
  let bytes = 0;
  let updatedAt: string | null = null;
  if (exists) {
    content = readFileSync(path, 'utf-8');
    const st = statSync(path);
    bytes = st.size;
    updatedAt = st.mtime.toISOString();
  }
  return { name, path, exists, content, bytes, updatedAt };
}

/**
 * Pi agent 的档案视图：它就是 `~/.pi/agent/agents/<name>.md` 一个文件，
 * **正文即人设（prompt）**，frontmatter 是配置。编辑时只动正文。
 */
function piView(id: string, name: EditableFile): AgentFileView | null {
  const rec = loadWaker(id);
  if (!rec || rec.origin !== 'pi') return null;
  try {
    const { body } = splitFrontmatter(readFileSync(rec.dir, 'utf-8'));
    const st = statSync(rec.dir);
    return { name, path: rec.dir, exists: true, content: body, bytes: st.size, updatedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** 列出该员工全部可编辑档案。Pi agent 只有"人设"这一份（对应 profile 正文）。 */
export function listAgentFiles(id: string): AgentFileView[] {
  const rec = loadWaker(id);
  if (rec?.origin === 'pi') {
    const v = piView(id, 'SOUL.md');
    return v ? [v] : [];
  }
  return EDITABLE_FILES.map((name) => view(id, name));
}

export function readAgentFile(id: string, name: EditableFile): AgentFileView {
  const rec = loadWaker(id);
  if (rec?.origin === 'pi') {
    return piView(id, name) ?? { name, path: rec.dir, exists: false, content: '', bytes: 0, updatedAt: null };
  }
  return view(id, name);
}

/**
 * 写入档案文件并**立即重新编译**。
 *
 * 重新编译是关键：注入文本是在外壳侧预生成的，
 * 不重新编译的话，改完 SOUL.md 要等到下次 run 才会生效。
 */
export function writeAgentFile(id: string, name: EditableFile, content: string): { recompiled: boolean } {
  const rec = loadWaker(id);
  if (!rec) throw new Error(`未找到员工：${id}`);

  // Pi agent：写回 profile 正文，frontmatter 原样保留
  if (rec.origin === 'pi') {
    if (!writePiProfileBody(id, content)) throw new Error('写入 Pi profile 失败');
    const fresh = loadWaker(id);
    if (fresh) writeCompiledArtifacts(fresh);
    return { recompiled: true };
  }

  const dir = agentDir(id);
  if (!existsSync(dir)) throw new Error(`未找到员工：${id}`);
  writeFileSync(join(dir, name), content, 'utf-8');

  const updated = loadWaker(id);
  if (!updated) return { recompiled: false };
  writeCompiledArtifacts(updated);
  return { recompiled: true };
}
