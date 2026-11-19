import { appendFileSync } from 'node:fs';
import { DECISIONS_LOG } from './paths.ts';

/**
 * 决策账本：把"一次自动推荐"从判定到用户选择、再到最终落点，串成一条可分析的记录。
 *
 * 为什么要单独一套（2026-11-08）：`routing.jsonl` 只记了**判定瞬间**——
 * 那晚最关键的三个问题它全答不了：
 *   1. 用户看到的是哪几个候选？点了哪一个？（决定"推荐准不准"）
 *   2. 用户是接受、拒绝，还是干脆自己发一句切走？（决定"该不该问"）
 *   3. 最后这句话被答在了哪个会话里？从发消息到落点花了多久？
 *
 * 所以这里改成**事件流**：同一条消息一个 `id`，先后写 `route → ask → answer → final`。
 * 追加写 JSONL、单行一条、失败绝不影响对话（与 tasks/todos 一致）。
 */

export type DecisionEvt = 'route' | 'ask' | 'answer' | 'final';

/** 用户对一次推荐做出的反应。 */
export type AnswerKind =
  /** 点了候选（或回数字 1..N）——这是最宝贵的正样本 */
  | 'candidate'
  /** 点了「留在《当前》」/ 回 N+1 —— 明确的负样本 */
  | 'stay'
  /** 点了「看看全部话题」/ 回 N+2 —— 说明现有候选都不对 */
  | 'list'
  /** 点了「以上都不是」——明确的"候选全错"负样本 */
  | 'none'
  /** 回了别的话，询问被放弃，按新问题走 */
  | 'text'
  /** 卡片一直没人点，过期后作废 */
  | 'timeout';

export interface CandidateSnapshot {
  /** 在卡片/日志里的展示名（会话标题）。 */
  name: string;
  id: string;
  /** 与本句的语义相似度；语义不可用时省略（不写 0，避免和"完全不像"混淆）。 */
  score?: number;
  /** 语义名次（1 = 最像）。 */
  rank: number;
}

export interface DecisionEvent {
  evt: DecisionEvt;
  /** 同一条消息的四个事件共用。 */
  id: string;
  at: string;
  [key: string]: unknown;
}

/**
 * 决策 id：时间戳 + 4 位随机十六进制。
 *
 * 为什么要可排序又不可预测：日志排查时经常按时间翻；而同一毫秒可能产生多条
 * （重投、群聊多人），加随机后缀避免撞号把两轮判定串成一条。
 */
export function newDecisionId(now: number = Date.now(), rand: () => number = Math.random): string {
  const tail = Math.floor(rand() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${now.toString(36)}-${tail}`;
}

/** 追加一条事件。写失败只吞掉——账本不能反过来影响对话。 */
export function appendDecision(evt: DecisionEvent): void {
  try {
    appendFileSync(DECISIONS_LOG, `${JSON.stringify(evt)}\n`, 'utf-8');
  } catch {
    /* 磁盘满 / 权限异常都不该影响回复 */
  }
}

/**
 * 候选快照：按给定顺序（通常是语义重排后的顺序）取前 N 条，带上分数与名次。
 *
 * `scoreOf` 返回 undefined 表示"这条没有向量"（候选批超时等），此时不写 `score`
 * 字段而不是写 0 —— 0 分和"没算过"在调阈值时是完全不同的两种信号。
 */
export function candidateSnapshots<T extends { id: string }>(args: {
  ranked: T[];
  nameOf: (s: T) => string;
  scoreOf: (id: string) => number | undefined;
  limit?: number;
}): CandidateSnapshot[] {
  const { ranked, nameOf, scoreOf, limit = 8 } = args;
  return ranked.slice(0, limit).map((s, i) => {
    const score = scoreOf(s.id);
    const snap: CandidateSnapshot = { name: nameOf(s), id: s.id, rank: i + 1 };
    if (score !== undefined) snap.score = Number(score.toFixed(3));
    return snap;
  });
}
