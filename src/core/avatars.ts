import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AVATARS_DIR, safeId } from './paths.ts';

/** 头像体积上限。前端已统一裁成方形并缩放到 256×256，正常远小于此值。 */
const MAX_BYTES = 512 * 1024;

/** PNG 魔数（前 4 字节）。 */
const PNG_MAGIC = 0x89504e47;

export function avatarFile(id: string): string {
  return join(AVATARS_DIR, `${safeId(id)}.png`);
}

export function hasAvatar(id: string): boolean {
  try {
    return statSync(avatarFile(id)).isFile();
  } catch {
    return false;
  }
}

export function readAvatar(id: string): Buffer | null {
  const file = avatarFile(id);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * 保存头像。只接受 **PNG 的 data URL**——前端用 canvas 统一裁成方形再上传，
 * 于是后端不必处理各种格式／尺寸，也不会把用户原始大图落盘。
 */
export function saveAvatar(id: string, dataUrl: string): void {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('只支持 PNG 头像（前端会自动转换）');
  const buf = Buffer.from(dataUrl.slice(prefix.length), 'base64');
  if (!buf.length) throw new Error('头像内容为空');
  if (buf.length > MAX_BYTES) throw new Error(`头像过大（${Math.round(buf.length / 1024)}KB），上限 ${MAX_BYTES / 1024}KB`);
  // 魔数校验：避免把任意 base64 当图片写进磁盘
  if (buf.length < 8 || buf.readUInt32BE(0) !== PNG_MAGIC) throw new Error('不是有效的 PNG 图片');
  mkdirSync(AVATARS_DIR, { recursive: true });
  writeFileSync(avatarFile(id), buf);
}

export function removeAvatar(id: string): boolean {
  const file = avatarFile(id);
  if (!existsSync(file)) return false;
  try {
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}
