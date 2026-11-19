import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * 兜底错误边界。任何渲染期异常都不再让整页变黑，
 * 而是显示可读的错误信息，便于定位（此前一次未捕获异常曾导致整页黑屏）。
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          className="min-h-full p-6 font-mono text-[12px] leading-relaxed"
          style={{ color: '#f87171' }}
        >
          <div className="mb-2 text-[14px] font-semibold">页面渲染出错（已拦截，避免整页黑屏）</div>
          <pre className="whitespace-pre-wrap break-words">
            {String(this.state.error.stack ?? this.state.error.message ?? this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
