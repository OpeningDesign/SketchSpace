// Imported by relative path, not by package name, so it is obvious at the
// import site that the editor comes from ./vendor (see scripts/sync-editor.mjs)
// and not from node_modules.
import "../../vendor/excalidraw/prod/index.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
