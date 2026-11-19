import { useMemo } from 'react';
import { Flame } from 'lucide-react';
import type { UsageDay, UsageView } from '../types';
import { fmtTokens, fmtCost } from '../format';

interface Props {
  usage: UsageView | null;
  /** 当前筛选的员工名，显示在标题旁。 */
  wakerName?: string;
}

/** 热度色阶：0 为空格，其余按当日 token 相对峰值分 4 档（绿色系）。 */
const LEVELS = ['bg-black/[0.05]', 'bg-[#cbdcc6]', 'bg-[#93c288]', 'bg-[#5c9f57]', 'bg-[#2f7a3a]'];

/** 星期几（0=周日），与格子纵向顺序一致。 */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
/** 单列宽度 = 格子 10px + 间距 2px；月份刻度用它换算横坐标。 */
const COL_W = 12;

function levelOf(tokens: number, max: number): number {
  if (tokens <= 0) return 0;
  if (max <= 0) return 1;
  const r = tokens / max;
  if (r >= 0.6) return 4;
  if (r >= 0.32) return 3;
  if (r >= 0.14) return 2;
  return 1;
}

/**
 * 使用统计：以"方格热力图 + 周期汇总"回答两个问题——
 * 它到底有没有在工作（方格）、花了多少（token 与费用）。
 */
export default function UsagePanel({ usage, wakerName }: Props): React.ReactElement {
  const { weeks, max, activeDays, monthTicks } = useMemo(() => {
    const days = usage?.days ?? [];
    let peak = 0;
    let active = 0;
    for (const d of days) {
      if (d.tokens > peak) peak = d.tokens;
      if (d.tokens > 0) active += 1;
    }
    // 按"周"排列：前面补空到周日，尾部补空到整周
    const cells: (UsageDay | null)[] = [];
    if (days.length) {
      const first = new Date(`${days[0]!.date}T00:00:00`);
      for (let i = 0; i < first.getDay(); i += 1) cells.push(null);
      for (const d of days) cells.push(d);
      while (cells.length % 7 !== 0) cells.push(null);
      }
      const w: (UsageDay | null)[][] = [];
      for (let i = 0; i < cells.length; i += 7) w.push(cells.slice(i, i + 7));
      // 月份刻度：某一列的起始日跨月时打一个标签，否则 26 周没有任何时间锚点
      const ticks: Array<{ col: number; label: string }> = [];
      let lastMonth = -1;
      w.forEach((week, i) => {
        const first = week.find((d) => d);
        if (!first) return;
        const m = new Date(`${first.date}T00:00:00`).getMonth();
        if (m !== lastMonth) {
          ticks.push({ col: i, label: `${m + 1}月` });
          lastMonth = m;
        }
      });
      return { weeks: w, max: peak, activeDays: active, monthTicks: ticks };
    }, [usage]);

  const t = usage?.totals;

  const periods: Array<{ label: string; p: { tokens: number; cost: number; runs: number } | undefined }> = [
    { label: '今日', p: t?.today },
    { label: '近 7 天', p: t?.week },
    { label: '近 30 天', p: t?.month },
  ];

  return (
    <section className="glass rounded-xl px-3.5 py-3">
      <header className="flex flex-wrap items-center gap-2">
        <Flame size={13} className="text-primary" />
        <span className="text-[13px] font-medium text-ink">使用统计</span>
        <span className="text-[11px] text-ink-muted">
          {wakerName ? `${wakerName} · ` : ''}近 {usage?.windowDays ?? 182} 天 · 每格一天
        </span>
        <span className="ml-auto font-mono text-[10px] text-ink-muted">
          活跃 {activeDays} 天 · {usage?.files ?? 0} 个会话
        </span>
      </header>

      {/* min-w-0 + truncate：大数字是 font-mono 不换行，不压住会把三列撑出面板 */}
      <div className="mt-2.5 grid grid-cols-3 gap-2 [&>*]:min-w-0">
        {periods.map(({ label, p }) => (
          <div key={label} className="rounded-lg border border-line bg-black/[0.02] px-2.5 py-2">
            <div className="text-[10px] text-ink-muted">{label}</div>
            <div className="mt-0.5 truncate font-mono text-[13px] font-semibold text-ink">{fmtTokens(p?.tokens ?? 0)}</div>
            <div className="truncate font-mono text-[10px] text-ink-muted">
              {fmtCost(p?.cost ?? 0)} · {p?.runs ?? 0} 次
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-1">
        {/* 星期标签：只标 一/三/五。七行全标会糊成一片，反而看不出这是日历 */}
        <div className="flex shrink-0 flex-col gap-[2px] pt-3">
          {WEEKDAYS.map((d, i) => (
            <div key={d} className="h-2.5 w-3 text-[9px] leading-[10px] text-ink-muted">
              {i % 2 === 1 ? d : ''}
            </div>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-x-auto pb-1">
          {/* 月份刻度：不然 26 周看下来完全没有时间锚点 */}
          <div className="relative h-3">
            {monthTicks.map((t) => (
              <span
                key={`${t.col}-${t.label}`}
                className="absolute whitespace-nowrap text-[9px] leading-none text-ink-muted"
                style={{ left: t.col * COL_W }}
              >
                {t.label}
              </span>
            ))}
          </div>

          <div className="flex gap-[2px]">
            {weeks.map((week, i) => (
              <div key={i} className="flex flex-col gap-[2px]">
                {week.map((d, j) => (
                  <div
                    key={j}
                    title={
                      d
                        ? `${d.date}（周${WEEKDAYS[j]}）· ${d.tokens.toLocaleString()} tokens · ${fmtCost(d.cost)} · ${d.runs} 次`
                        : '无数据'
                    }
                    className={`h-2.5 w-2.5 shrink-0 rounded-[2px] ${d ? LEVELS[levelOf(d.tokens, max)] : 'bg-transparent'}`}
                  />
                ))}
              </div>
            ))}
            {!weeks.length && <div className="py-2 text-[11px] text-ink-muted">暂无统计数据</div>}
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px] text-ink-muted">
        <span>少</span>
        {LEVELS.map((c, i) => (
          <span key={i} className={`h-2.5 w-2.5 rounded-[2px] ${c}`} />
        ))}
        <span>多</span>
        <span className="ml-auto">一格 = 一天 · 竖向是星期，横向是周 · 悬停看当天用量</span>
      </div>
    </section>
  );
}
