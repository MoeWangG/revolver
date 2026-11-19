#!/usr/bin/env node
/**
 * 仲裁 A/B 报表：主模型 vs 影子模型在同一批消息上的表现。
 *
 * 数据源：`data/routing.jsonl` 里 `source: 'shadow' | 'web-shadow'` 的行。
 * 每行是**一条消息一行**（不依赖 id 关联），字段：
 *   main:   { model, action, target }   ← 用户可见的那一个
 *   shadow: { model, action, target }   ← 只落日志的那一个
 *   agree:  boolean
 *
 * 回答三个问题：
 *   1. 两个模型一致率多少（不一致的样本才是判断谁更好的素材）；
 *   2. 各自判 new 的比例（这就是"发卡率"的上限）；
 *   3. 各自倾向：continue / new / switch 的分布。
 *
 * 用法：node --experimental-strip-types scripts/arbiter-ab.ts [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { ROUTING_LOG } from '../src/core/paths.ts';

interface Row {
  source?: string;
  at?: string;
  wakerId?: string;
  message?: string;
  main?: { model?: string; action?: string; target?: string };
  shadow?: { model?: string; action?: string; target?: string; ms?: number };
  agree?: boolean;
}

const rows: Row[] = existsSync(ROUTING_LOG)
  ? readFileSync(ROUTING_LOG, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Row;
        } catch {
          return {};
        }
      })
  : [];

const pairs = rows.filter((r) => r.source === 'shadow' || r.source === 'web-shadow');
if (!pairs.length) {
  console.log(`还没有对照数据（${ROUTING_LOG} 里没有 source=shadow 的行）。`);
  console.log('确认 agents/<id>/waker.yaml 的 session.arbiter.shadow.enabled = true，且有过一轮真实消息。');
  process.exit(0);
}

const count = (list: Row[], pick: (r: Row) => string | undefined): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of list) {
    const k = pick(r) ?? '(none)';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

const report = (name: string, list: Row[]): void => {
  const agree = list.filter((r) => r.agree).length;
  const mainNew = list.filter((r) => r.main?.action === 'new').length;
  const shadowNew = list.filter((r) => r.shadow?.action === 'new').length;
  const shadowMs = list.map((r) => r.shadow?.ms ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
  console.log(`\n## ${name}（${list.length} 条）`);
  console.log(`  一致率：${agree}/${list.length}${((agree / list.length) * 100).toFixed(1)}%`);
  console.log(`  主模型判 new：${mainNew} 条（${((mainNew / list.length) * 100).toFixed(1)}%）`);
  console.log(`  影子判 new  ：${shadowNew} 条（${((shadowNew / list.length) * 100).toFixed(1)}%）`);
  console.log(`  主模型动作：${JSON.stringify(count(list, (r) => r.main?.action))}`);
  console.log(`  影子动作  ：${JSON.stringify(count(list, (r) => r.shadow?.action))}`);
  if (shadowMs.length) {
    console.log(`  影子延迟 p50=${shadowMs[Math.floor(shadowMs.length / 2)]}ms`);
  }
  const disagree = list.filter((r) => !r.agree).slice(0, 10);
  if (disagree.length) {
    console.log('  不一致样本（前 10）：');
    for (const r of disagree) {
      console.log(`    「${(r.message ?? '').slice(0, 30)}」 main=${r.main?.action} shadow=${r.shadow?.action}`);
    }
  }
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: pairs.length, pairs }, null, 2));
} else {
  report('IM（飞书）', pairs.filter((p) => p.source === 'shadow'));
  report('网页', pairs.filter((p) => p.source === 'web-shadow'));
  console.log(`\n合计 ${pairs.length} 条对照`);
}
