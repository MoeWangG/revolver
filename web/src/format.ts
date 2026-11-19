/** 用量展示的统一格式：token 数与费用。列表、统计、对话窗共用，避免口径不一致。 */

export function fmtTokens(n: number): string {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** 费用：小额保留 4 位，避免一笔小账显示成 $0.00。 */
export function fmtCost(n: number): string {
  if (!n) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
