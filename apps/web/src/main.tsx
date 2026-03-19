import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PilotApp } from "./PilotApp";
import { PILOT_WIDGET } from "./config";
import "./styles.css";

type ErrorBoundaryState = {
  hasError: boolean;
};

class RootErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("RootErrorBoundary caught render error", error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="shell">
          <div className="card">
            <div className="title">Foxify Protect</div>
            <div className="disclaimer danger">
              Something went wrong. Please refresh and try again.
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <RootErrorBoundary>
      {PILOT_WIDGET ? <PilotApp /> : <App />}
    </RootErrorBoundary>
  </React.StrictMode>
);
