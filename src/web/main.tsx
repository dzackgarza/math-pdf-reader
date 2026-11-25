import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Router } from "wouter";
import "./index.css";
import App from "./App.tsx";
import ErrorBoundary from "./ErrorBoundary.tsx";
import { ReaderTabs } from "./tabs.tsx";
import { useLibraryLocation } from "./windowAddress";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element");
}

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
    <Router hook={useLibraryLocation}>
      <ReaderTabs>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </ReaderTabs>
    </Router>
  </StrictMode>,
);
