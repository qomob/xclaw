import React from 'react';

/**
 * 全局错误边界：任何渲染异常都不再白屏整个 SPA。
 * 独立于 i18n/主题等 Provider（这些 Provider 自身崩溃时也要能兜底），
 * 语言直接从 localStorage 读取。
 */
interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

function isEnglish(): boolean {
  try {
    return localStorage.getItem('xclaw_lang') === 'en';
  } catch {
    return false;
  }
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 控制台留痕，便于排障；生产环境可在此上报
    console.error('[XClaw] Render error captured by ErrorBoundary:', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleHome = () => {
    window.location.href = '/';
  };

  render() {
    if (!this.state.error) return this.props.children;

    const en = isEnglish();
    return (
      <div className="min-h-screen flex items-center justify-center p-8 bg-slate-950 text-slate-200">
        <div className="max-w-lg w-full rounded-2xl border border-slate-800 bg-slate-900/80 p-8 text-center">
          <div className="text-3xl mb-3">🦞</div>
          <h1 className="text-lg font-semibold mb-2">
            {en ? 'Something went wrong' : '页面出错了'}
          </h1>
          <p className="text-sm text-slate-400 mb-6">
            {en
              ? 'The page hit an unexpected error. Your data is safe — reload or go back to the overview.'
              : '页面遇到了未预期的错误，你的数据不受影响。可刷新重试或返回首页。'}
          </p>
          <pre className="text-left text-xs text-rose-300/80 bg-slate-950/60 rounded-lg p-3 mb-6 overflow-auto max-h-32">
            {this.state.error.message}
          </pre>
          <div className="flex gap-3 justify-center">
            <button
              onClick={this.handleReload}
              className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-400 text-white text-sm transition-colors"
            >
              {en ? 'Reload' : '刷新页面'}
            </button>
            <button
              onClick={this.handleHome}
              className="px-4 py-2 rounded-lg border border-slate-700 hover:border-slate-500 text-slate-300 text-sm transition-colors"
            >
              {en ? 'Back to overview' : '返回首页'}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
