import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FAVICON_PATH = fileURLToPath(new URL("../assets/favicon.svg", import.meta.url));
const DEFAULT_FAVICON_PUBLIC_PATH = "/favicon.svg";

export function vivdCatalystChatUiPlugin(options = {}) {
  const faviconPath = toPath(options.faviconPath ?? DEFAULT_FAVICON_PATH);
  const faviconPublicPath = normalizePublicPath(
    options.faviconPublicPath ?? DEFAULT_FAVICON_PUBLIC_PATH
  );
  const faviconRelativePath = faviconPublicPath.replace(/^\/+/, "");
  let config;

  return {
    name: "vivd-catalyst-chat-ui",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (
          !config ||
          requestPath(request.url) !== faviconPublicPath ||
          clientAssetExists(config, faviconRelativePath)
        ) {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader("content-type", "image/svg+xml; charset=utf-8");
        response.end(readFileSync(faviconPath));
      });
    },
    closeBundle() {
      if (!config || clientAssetExists(config, faviconRelativePath)) {
        return;
      }

      const outDir = resolveConfigPath(config.root, config.build.outDir);
      const faviconOutputPath = resolve(outDir, faviconRelativePath);
      if (existsSync(faviconOutputPath)) {
        return;
      }

      mkdirSync(dirname(faviconOutputPath), { recursive: true });
      copyFileSync(faviconPath, faviconOutputPath);
    }
  };
}

function clientAssetExists(config, relativePath) {
  if (config.publicDir === false) {
    return false;
  }
  return existsSync(resolve(resolveConfigPath(config.root, config.publicDir), relativePath));
}

function normalizePublicPath(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

function requestPath(url) {
  return url?.split(/[?#]/, 1)[0];
}

function resolveConfigPath(root, path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

function toPath(value) {
  return value instanceof URL ? fileURLToPath(value) : value;
}
