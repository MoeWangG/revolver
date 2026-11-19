/**
 * 生成前端用的架构快照（`web/src/generated/architecture.json`）。
 *
 * 为什么要有这一步：架构页最初只走 `GET /api/architecture`，而看板是常驻进程——
 * 前端重建了、网关没重启（launchd 只在崩溃时才拉起），页面就拿不到数据：
 * 旧网关对新路径会落到 SPA 回退，返回的是一段 HTML，前端 JSON 解析直接失败。
 * 页面依赖运行时接口，"每次更新系统就能看到改了什么"就不成立了。
 *
 * 所以把内容在**构建时**烘进 bundle：更新系统 = 重新构建前端，页面必然跟着变，
 * 与网关是否重启无关。运行时若能连上网关，再用它的返回覆盖（同一份 `readArchitecture()`，
 * 内容一致，只是拿得到更新的时间戳），这样"改了 CHANGELOG 刷新即见"的便利也保留。
 *
 * 快照里刻意去掉 `generatedAt`：它是"这次读的时间"，每次构建都不同，
 * 留在仓库里会让每次构建都产生一行无意义 diff。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readArchitecture } from '../src/core/architecture.ts';
import { PLATFORM_ROOT } from '../src/core/paths.ts';

const out = join(PLATFORM_ROOT, 'web', 'src', 'generated', 'architecture.json');
const view = readArchitecture();
delete (view as { generatedAt?: string }).generatedAt;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(view, null, 2)}\n`, 'utf-8');
console.log(`架构快照已写入 ${out}（v${view.version}，${view.releases.length} 个版本）`);
