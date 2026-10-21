import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * The interface of the browser suite, which scripts/run-chat-e2e.mjs builds and serves as files,
 * and beside it the page of another site that embeds the widget (view-runtime.spec.ts).
 */
export default mergeConfig(
  base,
  defineConfig({
    build: {
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("index.html", import.meta.url)),
          widget: fileURLToPath(new URL("e2e-widget.html", import.meta.url))
        }
      }
    }
  })
);
