import { Component, type ReactNode } from 'react'

/** 嵌入式探索页（QQ/网易云）的局部错误边界：崩溃时显示错误详情而不是黑掉整个窗口 */
export default class EmbeddedExploreErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[TraditionalView] ${this.props.label} 渲染崩溃:`, error, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-sm font-medium text-rose-300">{this.props.label} 渲染出错</div>
          <pre className="max-w-[640px] overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/40 p-3 text-left text-xs text-white/60">
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack?.slice(0, 1200)}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-full px-4 py-1.5 text-xs text-white"
            style={{ background: 'var(--explore-accent, #fa2d48)' }}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
