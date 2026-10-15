import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createChatUiContentPolicy } from "./content-policy.js";
import { readChatUiEnv } from "./env.js";
import {
  createClientBranding,
  loadClientInstanceConfigFromFile
} from "@work-shape/catalyst-config-schema";
import { createThemeTokens, serializeThemeRule } from "@work-shape/catalyst-ui/theme";

const DEFAULT_FAVICON_PUBLIC_PATH = "/favicon.svg";
const DEFAULT_CLIENT_CONFIG_PATH = "config/app.yaml";
const THEME_STORAGE_KEY = "vivd-catalyst:theme";

export function vivdCatalystChatUiPlugin(options = {}) {
  const faviconPath = options.faviconPath ? toPath(options.faviconPath) : undefined;
  const faviconPublicPath = normalizePublicPath(
    options.faviconPublicPath ?? DEFAULT_FAVICON_PUBLIC_PATH
  );
  const faviconRelativePath = faviconPublicPath.replace(/^\/+/, "");
  const injectBrandingBootstrap = options.brandingBootstrap !== false;
  const injectContentPolicy = options.contentPolicy !== false;
  let config;

  return {
    name: "vivd-catalyst-chat-ui",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    async transformIndexHtml() {
      if (!config) {
        return undefined;
      }

      const clientConfig = await loadClientConfig(config, options);
      const tags = [];
      if (injectContentPolicy) {
        // First in the head: a policy in a meta tag governs only what comes after it.
        tags.push({
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: createChatUiContentPolicy({
              apiUrl: config.env?.VITE_CHAT_API_URL,
              apiPort: config.env?.VITE_CHAT_API_PORT,
              imageUrls: clientConfig
                ? [clientConfig.ui.logoUrl, clientConfig.ui.logoUrlDark, clientConfig.ui.faviconUrl]
                : [],
              dev: config.command === "serve"
            })
          },
          injectTo: "head-prepend"
        });
      }

      if (injectBrandingBootstrap && clientConfig) {
        const branding = createClientBranding(clientConfig);
        tags.push(
          {
            tag: "script",
            attrs: { id: "vivd-catalyst-theme-bootstrap" },
            children: createThemeBootstrapScript(branding.defaultThemeMode),
            injectTo: "head-prepend"
          },
          {
            tag: "style",
            attrs: { id: "vivd-catalyst-theme-bootstrap-style" },
            children: createThemeBootstrapStyle(branding),
            injectTo: "head-prepend"
          }
        );
      }

      return tags.length > 0 ? tags : undefined;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (
          !config ||
          !faviconPath ||
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
      if (!config || !faviconPath || clientAssetExists(config, faviconRelativePath)) {
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

async function loadClientConfig(config, options) {
  const env = readChatUiEnv();
  const configPathInput =
    options.clientConfigPath ?? env.clientConfigPath ?? DEFAULT_CLIENT_CONFIG_PATH;
  const explicitConfigPath = Boolean(options.clientConfigPath ?? env.clientConfigPath);
  const configPath = resolveConfigPath(config.root, configPathInput);

  if (!existsSync(configPath)) {
    if (explicitConfigPath) {
      config.logger?.warn?.(
        `[vivd-catalyst-chat-ui] client config not found for branding bootstrap: ${configPath}`
      );
    }
    return undefined;
  }

  return loadClientInstanceConfigFromFile(configPath);
}

function createThemeBootstrapScript(defaultThemeMode) {
  const fallbackThemeMode = defaultThemeMode === "dark" ? "dark" : "light";
  return `(()=>{const key=${JSON.stringify(THEME_STORAGE_KEY)},fallback=${JSON.stringify(
    fallbackThemeMode
  )},defaultMode=${JSON.stringify(
    defaultThemeMode
  )};function resolve(){try{const stored=localStorage.getItem(key);if(stored==="dark"||stored==="light")return stored;}catch{}if(defaultMode==="dark"||defaultMode==="light")return defaultMode;return typeof matchMedia==="function"&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}try{document.documentElement.dataset.vivdTheme=resolve()}catch{document.documentElement.dataset.vivdTheme=fallback}})();`;
}

function createThemeBootstrapStyle(branding) {
  const lightVariables = createThemeTokens(branding.theme, "light");
  const darkVariables = createThemeTokens(branding.darkTheme, "dark");
  const fallbackThemeMode = branding.defaultThemeMode === "dark" ? "dark" : "light";
  const fallbackVariables = fallbackThemeMode === "dark" ? darkVariables : lightVariables;
  const fallbackRules = [
    serializeThemeRule(":root:not([data-vivd-theme])", fallbackVariables),
    branding.defaultThemeMode === "system"
      ? `@media (prefers-color-scheme: dark){${serializeThemeRule(
          ":root:not([data-vivd-theme])",
          darkVariables
        )}}`
      : ""
  ].join("");

  return [
    fallbackRules,
    serializeThemeRule(':root[data-vivd-theme="light"]', lightVariables),
    serializeThemeRule(':root[data-vivd-theme="dark"]', darkVariables),
    "html,body,#root{background:var(--background);color:var(--foreground);}"
  ].join("");
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
