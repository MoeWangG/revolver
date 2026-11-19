/**
 * 把员工产出的 Markdown 转成飞书**交互卡片**元素。
 *
 * 为什么要卡片：飞书 `msg_type=text` **不渲染任何 Markdown**，`**加粗**` / `## 标题` /
 * `- 列表` 会原样显示成源码符号——和看板没渲染是同一个毛病的两副面孔。
 * 卡片的 `markdown` 元素支持这些常用语法，回复于是能正常排版。
 *
 * 兼容性取舍（卡片语法不是完整 CommonMark，且只支持 `markdown` / `hr` / `div` 这几个元素，
 * 能少依赖就少依赖）：
 * - 围栏代码块 → **仍留在 markdown 元素里**（实测卡片不接受独立的 `code` 元素，
 *   真实接口报 `not support tag: code`，整条消息会被拒收）；
 * - `---` → 独立 `hr` 元素；
 * - `#` 标题 → **加粗**（卡片对多级标题的支持不一致，宁可降级也别显示成 `# 一、概览`）；
 * - 表格 → 「字段: 值」列表（卡片不支持表格，竖线表在聊天窗口里很难读）；
 * - 其余（加粗 / 斜体 / 删除线 / 行内代码 / 链接 / 有序无序列表 / 引用）原样交给 markdown 元素。
 *
 * 发送侧还有一层兜底（见 feishu.ts）：卡片发不出去就回落到纯文本，
 * 保证答案不会因为"想渲染好看"而丢。
 */

/** 卡片 JSON 2.0 的元素（渠道层按结构化动态使用，不追求类型完备）。 */
export type CardElement = Record<string, unknown>;

/** 一条消息里 markdown 元素的字符预算。卡片 JSON 上限约 30KB，转义最坏 6 倍，取 4000 留足余量。 */
const CARD_BUDGET = 4000;

/** 文本里是否含 Markdown 记号。短问短答应保持纯文本，不必套一层卡片壳。 */
export function hasMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}#{1,6}\s|\*\*|~~|```|\[[^\]]+\]\(https?:\/\/|^\s{0,3}[-*+]\s|^\s{0,3}\d+\.\s|\n\|/.test(text);
}

/** 单元格文本：去掉首尾空格与包裹的反引号。 */
function cell(s: string): string {
  return s.trim().replace(/^\*\*(.*)\*\*$/, '$1').replace(/^`(.*)`$/, '$1').replace(/\*\*(.*)\*\*$/, '$1').trim();
}

/** 拆表格行：按 `|` 切，跳掉首尾空段（`a|b` 与 `| a | b |` 都要能处理）。 */
function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map(cell);
}

/** 是不是表格的分隔行（`|---|:--:|`）。 */
function isSepRow(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|');
}

/**
 * 表格 → 列表。
 * 两列是最常见的「字段: 值」形态，直接映射；多列表格保留列头一行，行内用 `｜` 分隔。
 */
function tableToLines(rows: string[][]): string[] {
  const head = rows[0] ?? [];
  const body = rows.slice(1);
  if (!head.length) return [];
  const out: string[] = [];
  if (head.length === 2) {
    for (const r of body) if (r.length >= 2 && (r[0] || r[1])) out.push(`- **${r[0]}**：${r[1]}`);
    if (!out.length && body.length) for (const r of body) out.push(`- ${r.join(' ｜ ')}`);
    return out;
  }
  out.push(`**${head.join(' ｜ ')}**`);
  for (const r of body) if (r.some(Boolean)) out.push(`- ${r.join(' ｜ ')}`);
  return out;
}

/** 行扫描：把 Markdown 拆成卡片元素序列（md / hr / code）。 */
function toElements(md: string): CardElement[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: CardElement[] = [];
  let buf: string[] = [];

  const flush = (): void => {
    if (!buf.length) return;
    const content = buf.join('\n').trim();
    if (content) out.push({ tag: 'markdown', content });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // 围栏代码块：整块收成独立的 markdown 元素（内含围栏）。
    // 注意**不能用卡片的 `code` 元素**——实测真实接口直接拒收：
    // `not support tag: code`（code: 200621），整条消息发不出去。卡片只认 markdown 元素里的围栏。
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !/^\s*```\s*$/.test(lines[j] ?? ''); j++) body.push(lines[j] ?? '');
      const lang = fence[1] ?? '';
      out.push({ tag: 'markdown', content: `\`\`\`${lang}\n${body.join('\n')}\n\`\`\`` });
      i = j;
      continue;
    }

    // 表格：一行带 `|` 且下一行是分隔行
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isSepRow(lines[i + 1] ?? '')) {
      flush();
      const rows: string[][] = [splitRow(line)];
      let j = i + 2;
      for (; j < lines.length && /^\s*\|/.test(lines[j] ?? ''); j++) rows.push(splitRow(lines[j] ?? ''));
      out.push({ tag: 'markdown', content: tableToLines(rows).join('\n') });
      i = j - 1;
      continue;
    }

    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push({ tag: 'hr' });
      continue;
    }

    // 标题：降级为加粗（卡片对 `#` 的支持不一致）
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ tag: 'markdown', content: `**${(h[1] ?? '').trim()}**` });
      continue;
    }

    buf.push(line);
  }
  flush();
  return out;
}

/** 元素文本长度（用于按预算分包）。 */
function len(el: CardElement): number {
  return String(el.content ?? '').length;
}

/** 超长单元素按行切开（代码块动辄几百行，不切会撞卡片上限）。 */
function splitOversize(el: CardElement): CardElement[] {
  if (len(el) <= CARD_BUDGET) return [el];
  const lines = String(el.content).split('\n');
  const parts: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (cur.length && cur.join('\n').length + l.length + 1 > CARD_BUDGET) {
      parts.push(cur.join('\n'));
      cur = [];
    }
    // 单行就超预算：硬切
    if (l.length > CARD_BUDGET) {
      if (cur.length) {
        parts.push(cur.join('\n'));
        cur = [];
      }
      for (let p = 0; p < l.length; p += CARD_BUDGET) parts.push(l.slice(p, p + CARD_BUDGET));
      continue;
    }
    cur.push(l);
  }
  if (cur.length) parts.push(cur.join('\n'));
  return parts.map((content) => ({ ...el, content }));
}

/**
 * Markdown → 多张卡片（每张卡片的 JSON 直接当 `msg_type=interactive` 的 content）。
 *
 * 分包按元素边界切，不从中间切断句子——之前的纯文本分包是按字符切的，
 * 一句话被劈成两半在飞书里是两条消息，读起来是断的。
 */
export function markdownToCards(md: string): unknown[] {
  const flat = toElements(md).flatMap(splitOversize);
  const cards: CardElement[][] = [];
  let cur: CardElement[] = [];
  let used = 0;
  for (const el of flat) {
    const l = len(el);
    if (cur.length && used + l > CARD_BUDGET) {
      cards.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(el);
    used += l;
  }
  if (cur.length) cards.push(cur);
  return cards.map((elements) => ({
    schema: '2.0',
    body: { elements },
    config: { wide_screen_mode: true, update_multi: true },
  }));
}
