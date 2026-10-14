/** Mounts the workbench into jsdom for tests/memory-ui.mjs. */
import { createRoot } from "react-dom/client";
import { App } from "../src/App";

const root = document.getElementById("root");
if (!root) throw new Error("no #root");
createRoot(root).render(<App />);
