import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 统一的 Markdown 渲染件。
 *
 * 为什么需要：员工的回复大量用 `**加粗**` / `## 标题` / `- 列表` / 表格来组织信息，
 * 之前一律按纯文本 `whitespace-pre-wrap` 显示，读者看到的是一堆源码符号（`**`、`#`）。
 * 聊天窗（AgentChatDialog）与任务详情（DetailDrawer）都改成走这里。
 *
 * 实现取舍：
 * - 用 react-markdown + remark-gfm（表格/删除线/任务列表），不自己写正则解析器；
 * - **不装 @tailwindcss/typography**：它的默认间距按 16px 正文设计，塞进 13px 的聊天气泡里
 *   会显得松垮，这里按气泡尺度手写样式，与全局 token（primary/ink/line）对齐；
 * - **不启用 rehype-raw**：模型输出里的原始 HTML 一律当文本，不注入 DOM；
 * - 链接统一 `target=_blank rel=noreferrer`，javascript: 之类由 react-markdown 的
 *   默认 urlTransform 拦掉。
 *
 * 表格与代码块横向可滚（`overflow-x-auto`），否则宽表会把气泡撑破布局。
 */
export default function Md({
  text,
  className = '',
}: {
  text: string;
  /** 外层类名，一般只用来调字号/颜色 */
  className?: string;
}): React.ReactElement | null {
  if (!text) return null;
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 标题：气泡里尺度要收着，否则一句话占三行
          h1: ({ children }) => (
            <h1 className="mb-1 mt-2.5 text-[15px] font-semibold leading-snug first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-1 mt-2.5 text-[14px] font-semibold leading-snug first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1 mt-2 text-[13px] font-semibold leading-snug first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-0.5 mt-2 text-[13px] font-semibold leading-snug first:mt-0">{children}</h4>
          ),
          p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4 first:mt-0">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4 first:mt-0">{children}</ol>,
          li: ({ children, ...rest }) => {
            // react-markdown 9 不再给 li 传 inline 属性；子节点若是 p 会多出段间距
            const kids = React.Children.toArray(children);
            return (
              <li {...rest}>
                {kids.map((k, i) =>
                  React.isValidElement(k) && (k as React.ReactElement).type === 'p' ? (
                    <span key={i} className="inline">
                      {(k as React.ReactElement).props.children}
                    </span>
                  ) : (
                    k
                  ),
                )}
              </li>
            );
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="text-ink-muted">{children}</del>,
          hr: () => <hr className="my-2.5 border-line" />,
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-primary/50 pl-2.5 text-ink-muted">{children}</blockquote>
          ),
          code: ({ children, className: cls }) => {
            // 行内代码：className 为空即 inline；围栏代码块带 language-xxx
            const isBlock = !!cls?.startsWith('language-');
            if (!isBlock) {
              return (
                <code className="rounded bg-black/[0.07] px-1 py-px font-mono text-[12px] text-primary-deep">
                  {children}
                </code>
              );
            }
            return null; // 围栏块交给下面的 pre，避免双层容器
          },
          pre: ({ children }) => (
            <pre className="my-1.5 max-w-full overflow-x-auto rounded-lg border border-line bg-black/[0.05] p-2.5 font-mono text-[11.5px] leading-relaxed text-ink">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-1.5 max-w-full overflow-x-auto rounded-lg border border-line">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-black/[0.04]">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-line px-2 py-1 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border-b border-line/60 px-2 py-1 align-top">{children}</td>,
          input: ({ checked, ...rest }) => (
            <input type="checkbox" checked={checked} readOnly {...rest} className="mr-1 align-middle accent-primary" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
