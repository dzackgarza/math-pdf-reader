import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import "./index.css";
import App from "./App.tsx";
import ErrorBoundary from "./ErrorBoundary.tsx";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element");
}

// The webview's own page menu (Back, Reload, Inspect) is not the app's; the app's menus open
// on rows and headers. Text fields and selected text keep the platform menu for copy and paste.
document.addEventListener("contextmenu", (event) => {
  const target = event.target;
  const editable =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);
  const selecting = (window.getSelection()?.toString() ?? "").length > 0;
  if (!editable && !selecting) {
    event.preventDefault();
  }
});

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Router hook={useHashLocation}>
        <App />
      </Router>
    </ErrorBoundary>
  </StrictMode>,
);
