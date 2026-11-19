import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { EXTENSIONS_SRC_DIR, PI_EXTENSIONS_DIR } from './paths.ts';

/**
 * 把 extensions/*.ts 软链进 ~/.pi/agent/extensions/。
 *
 * 沿用本机 memory.ts / wal.ts 的既有做法：单一事实源在项目内，Pi 侧只放软链，
 * 两边各自演进不会分叉。
 *
 * 幂等：已指向同一目标的软链直接跳过；遇到同名**实体文件**先备份再替换，
 * 绝不静默覆盖用户已有代码。
 */
export function linkExtensions(): void {
  if (!existsSync(EXTENSIONS_SRC_DIR)) {
    console.error(`找不到扩展源目录：${EXTENSIONS_SRC_DIR}`);
    process.exit(1);
  }
  mkdirSync(PI_EXTENSIONS_DIR, { recursive: true });

  let linked = 0;
  for (const name of readdirSync(EXTENSIONS_SRC_DIR)) {
    // 只投放运行时扩展：.d.ts 是给 tsc 看的类型声明，Pi 不应加载
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
    const src = join(EXTENSIONS_SRC_DIR, name);
    const dest = join(PI_EXTENSIONS_DIR, name);

    if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
      const isLink = lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink();
      if (isLink) {
        try {
          if (readlinkSync(dest) === src) {
            console.log(`已链接：${name}`);
            linked += 1;
            continue;
          }
        } catch {
          /* 读不到链接目标则按替换处理 */
        }
        // 指向别处：必须先删除旧软链 —— symlinkSync 不会覆盖已存在的条目（EEXIST）
        rmSync(dest, { force: true });
      } else if (existsSync(dest)) {
        const backup = `${dest}.bak-${Date.now()}`;
        renameSync(dest, backup);
        console.warn(`发现同名实体文件，已备份：${backup}`);
      }
    }

    symlinkSync(src, dest);
    console.log(`已链接：${name} -> ${src}`);
    linked += 1;
  }

  if (linked === 0) {
    console.error('没有待链接的扩展');
    process.exit(1);
  }
  console.log('\n生效方式：在 pi 会话中执行 /reload，或完全重启 pi。');
}
