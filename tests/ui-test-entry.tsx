/** Mounts the workbench into jsdom for tests/memory-ui.mjs. */
import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { hydrate } from "../src/lib/storage";

const root = document.getElementById("root");
if (!root) throw new Error("no #root");
void hydrate().finally(() => createRoot(root).render(<App />));
