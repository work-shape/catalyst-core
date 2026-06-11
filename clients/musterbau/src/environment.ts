import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

export const clientRoot = fileURLToPath(new URL("..", import.meta.url));
export const workspaceRoot = resolve(clientRoot, "../..");

export function loadClientEnvironment(): void {
  loadDotenv({ path: resolve(workspaceRoot, ".env"), quiet: true });
  loadDotenv({ path: resolve(clientRoot, ".env"), override: true, quiet: true });
}

export function resolveConfigPath(configPath: string | undefined): string {
  if (!configPath) {
    return resolve(clientRoot, "config/app.yaml");
  }
  if (isAbsolute(configPath)) {
    return configPath;
  }

  const workspacePath = resolve(workspaceRoot, configPath);
  if (existsSync(workspacePath)) {
    return workspacePath;
  }
  return resolve(clientRoot, configPath);
}
