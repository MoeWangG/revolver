import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeishuChannelConfig } from '../types.ts';
import { CHANNELS_DIR, safeId } from './paths.ts';
import { loadWaker } from './registry.ts';

/**
 * 渠道配置存平台侧 `data/channels/<id>.json`，**与员工目录解耦**。
 *
 * 这样做的原因：纳管的 Pi agent（如 Public-Opinion / coder）没有自己的档案目录，
 * 若把渠道配置绑在员工目录上，它们就永远配不了飞书。解耦后**任何员工都能挂渠道**。
 * 密钥单独存 `data/channels/<id>.secret.json`（整个 data/ 都在 gitignore 内）。
 */
export interface ChannelConfigFile {
  feishu?: FeishuChannelConfig;
}

export function channelConfigPath(id: string): string {
  return join(CHANNELS_DIR, `${safeId(id)}.json`);
}

export function channelSecretsPath(id: string): string {
  return join(CHANNELS_DIR, `${safeId(id)}.secret.json`);
}

function readJson(p: string): Record<string, unknown> {
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function ensureDir(): void {
  if (!existsSync(CHANNELS_DIR)) mkdirSync(CHANNELS_DIR, { recursive: true });
}

/** 渠道配置视图（合并后的结果；**不返回 appSecret 明文**，只告知是否已配置）。 */
export interface ChannelConfigView {
  feishu: Omit<FeishuChannelConfig, 'appSecret'> | null;
  hasAppSecret: boolean;
  path: string;
}

export function readChannelConfig(id: string): ChannelConfigView {
  const rec = loadWaker(id);
  const fs = rec?.def.channels?.feishu;
  if (!fs) return { feishu: null, hasAppSecret: false, path: channelConfigPath(id) };
  const { appSecret, ...rest } = fs;
  return { feishu: rest, hasAppSecret: Boolean(appSecret), path: channelConfigPath(id) };
}

/**
 * 写入渠道配置：非密钥字段写 `data/channels/<id>.json`，`appSecret`（若传入）写
 * `data/channels/<id>.secret.json`。只覆盖传入的字段，保留其余既有值。
 */
export function writeChannelConfig(id: string, feishu: FeishuChannelConfig, appSecret?: string): void {
  ensureDir();
  const p = channelConfigPath(id);
  const cur = readJson(p) as ChannelConfigFile;
  const merged: FeishuChannelConfig = { ...(cur.feishu ?? {}), ...feishu };
  delete (merged as { appSecret?: string }).appSecret; // 密钥绝不落到非密钥文件
  writeFileSync(p, `${JSON.stringify({ ...cur, feishu: merged }, null, 2)}\n`, 'utf-8');

  if (appSecret !== undefined) {
    const sp = channelSecretsPath(id);
    const sec = readJson(sp) as { feishu?: { appSecret?: string } };
    sec.feishu = { ...(sec.feishu ?? {}), appSecret };
    writeFileSync(sp, `${JSON.stringify(sec, null, 2)}\n`, 'utf-8');
  }
}
