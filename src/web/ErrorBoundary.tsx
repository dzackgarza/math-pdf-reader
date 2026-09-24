import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryState = { error: Error | null; componentStack: ErrorInfo["componentStack"] };

// A render failure shows what failed instead of a blank window.
export default class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, componentStack: info.componentStack });
  }

  render() {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div className="flex h-full items-center justify-center bg-surface p-6">
        <section
          role="alert"
          className="w-full max-w-3xl rounded-xl bg-panel p-6 shadow-lg ring-1 ring-line"
        >
          <h1 className="flex items-center gap-2 text-lg font-semibold text-danger">
            <AlertTriangle aria-hidden className="h-5 w-5" /> The library window failed to render
          </h1>
          <pre className="mt-4 overflow-x-auto rounded-lg bg-surface p-4 font-mono text-xs whitespace-pre-wrap">
            {String(this.state.error)}
            {this.state.componentStack}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Reload the window
          </button>
        </section>
      </div>
    );
  }
}
