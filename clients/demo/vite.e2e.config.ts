import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

/**
 * The interface server of the browser suite. The suite serves the sources as they are when it
 * starts and edits none of them, so this server watches no file: a change the watcher reports
 * during a run, real or not, would restart the server or reload modules under the page a test
 * is on.
 */
export default mergeConfig(base, defineConfig({ server: { watch: null, hmr: false } }));
