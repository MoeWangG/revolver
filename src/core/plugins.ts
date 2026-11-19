import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.ts';

/**
 * 插件入口：把本机已有的 pi 生态页面挂到看板上，点击跳转。
 * 可在 `data/plugins.json` 里增删；文件不存在时用内置默认清单。
 */
export interface PluginEntry {
  name: string;
  url: string;
  desc?: string;
}

/**
 * 默认清单**刻意留空**。
 *
 * 原先内置了一条「Monkey 任务台 → http://127.0.0.1:8791」，但那个服务（feishu-bot 的
 * console）已经退役、launchd 服务被 disable，留着就是一个指向死链的卡片。
 * 本机还有别的 pi 页面要挂时，写进 `data/plugins.json` 即可。
 */
const DEFAULTS: PluginEntry[] = [];

export function loadPlugins(): PluginEntry[] {
  const p = join(DATA_DIR, 'plugins.json');
  if (!existsSync(p)) return DEFAULTS;
  try {
    const list = JSON.parse(readFileSync(p, 'utf-8')) as PluginEntry[];
    return Array.isArray(list) && list.length ? list : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}
