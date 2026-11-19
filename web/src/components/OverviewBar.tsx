import {
  Play,
  Hourglass,
  ListTodo,
  Users,
  Clock,
  MessageSquare,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  CircleX,
  Timer,
} from 'lucide-react';
import type { BoardSnapshot } from '../types';
import { formatAgo } from './statusMeta';

interface Props {
  snapshot: BoardSnapshot | null;
}

function Kpi({
  icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone: string;
  /** 悬停说明：口径容易误解的指标写清楚怎么算的。 */
  hint?: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5" title={hint ?? label}>
      <span className={tone}>{icon}</span>
      <span className="text-[11px] text-ink-muted">{label}</span>
      <span className={`flex items-center gap-2 font-mono text-[13px] font-semibold ${tone}`}>{value}</span>
    </div>
  );
}

/**
 * 状态计数：**图标代表状态，数字跟在后面**。
 * 写成"已完成 0 / 待完成 0 / 计划中 0"会把总览栏撑成一排粗字，既占地方又吵。
 */
function Stat({
  icon,
  n,
  tone,
  hint,
}: {
  icon: React.ReactNode;
  n: number;
  tone: string;
  hint: string;
}): React.ReactElement {
  return (
    <span className={`flex items-center gap-0.5 ${tone}`} title={hint}>
      {icon}
      <span className="font-mono text-[13px] font-semibold">{n}</span>
    </span>
  );
}

/**
 * 总览栏：只放"今天要关心的事"。
 *
 * 去过两版：
 *  - 最早是「运行中 / 待确认 / 失败 / 成功 / 今日任务」——成功/失败是**历史累计**，
 *    和"今天"混在一起，499 / 12 这种数字除了证明跑过很多次，没有决策价值；
 *  - 现在改成「今天你问了多少次」「今天待办做完几件、还剩几件」，
 *    都是能直接对照行动的指标。
 *
 * 依赖健康（Pi / 记忆服务 / 渠道）归顶栏；这里不重复第二份。
 */
export default function OverviewBar({ snapshot }: Props): React.ReactElement {
  const c = snapshot?.counts;
  const todayAsked = (snapshot?.wakers ?? []).reduce((a, w) => a + w.todayTasks, 0);
  const todo = snapshot?.todoStats;
  const cron = snapshot?.cronStats;

  return (
    <section className="glass flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-4 py-2.5">
      <Kpi icon={<Play size={12} />} label="运行中" value={c?.running ?? 0} tone="text-primary" />
      <Kpi icon={<Hourglass size={12} />} label="待确认" value={c?.awaiting ?? 0} tone="text-state-warn" />

      <span className="hidden h-4 w-px bg-line sm:block" />

      <Kpi
        icon={<MessageSquare size={12} />}
        label="今日提问"
        value={`${todayAsked} 次`}
        tone="text-ink"
        hint="今天（本地时区）你发起了多少次对话：在飞书 / 看板每发一条消息算一次"
      />
      <Kpi
        icon={<ListTodo size={12} />}
        label="今日待办"
        tone="text-ink"
        hint="✓ 今天处理掉的　○ 今天该处理却没做完（截止≤今天，含逾期）"
        value={
          <>
            <Stat
              icon={<CheckCircle2 size={12} />}
              n={todo?.doneToday ?? 0}
              tone="text-state-ok"
              hint={`已完成 ${todo?.doneToday ?? 0} 条（今天处理掉的）`}
            />
            <Stat
              icon={<CircleDashed size={12} />}
              n={todo?.pendingToday ?? 0}
              tone="text-state-warn"
              hint={`待完成 ${todo?.pendingToday ?? 0} 条（截止≤今天、还没做完，含逾期）`}
            />
          </>
        }
      />
      <Kpi
        icon={<CalendarClock size={12} />}
        label="定时任务"
        tone="text-ink"
        hint="✓ 成功　✕ 失败　⏱ 计划中（只统计当前仍存在的任务）"
        value={
          <>
            <Stat
              icon={<CheckCircle2 size={12} />}
              n={cron?.success ?? 0}
              tone="text-state-ok"
              hint={`成功 ${cron?.success ?? 0} 次`}
            />
            <Stat
              icon={<CircleX size={12} />}
              n={cron?.failed ?? 0}
              tone="text-state-bad"
              hint={`失败 ${cron?.failed ?? 0} 次`}
            />
            <Stat
              icon={<Timer size={12} />}
              n={cron?.planned ?? 0}
              tone="text-ink-muted"
              hint={`计划中 ${cron?.planned ?? 0} 个（启用中的任务；已删除任务的历史不计入）`}
            />
          </>
        }
      />
      <Kpi icon={<Users size={12} />} label="员工" value={snapshot?.wakers.length ?? 0} tone="text-ink" />

      <div className="ml-auto flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-ink-muted" title="看板数据的新鲜度">
          <Clock size={11} />
          心跳 {formatAgo(snapshot?.generatedAt)}
        </span>
      </div>
    </section>
  );
}
