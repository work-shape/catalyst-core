import { readChatUiEnv } from "../dist/env.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClientBranding,
  loadClientInstanceConfigFromFile
} from "@vivd-catalyst/config-schema";
import { createThemeTokens, serializeThemeRule } from "@vivd-catalyst/ui/theme";

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
  let config;

  return {
    name: "vivd-catalyst-chat-ui",
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    async transformIndexHtml() {
      if (!config || !injectBrandingBootstrap) {
        return undefined;
      }

      const brandingBootstrap = await createBrandingBootstrap(config, options);
      if (!brandingBootstrap) {
        return undefined;
      }

      return [
        {
          tag: "script",
          attrs: { id: "vivd-catalyst-theme-bootstrap" },
          children: brandingBootstrap.script,
          injectTo: "head-prepend"
        },
        {
          tag: "style",
          attrs: { id: "vivd-catalyst-theme-bootstrap-style" },
          children: brandingBootstrap.style,
          injectTo: "head-prepend"
        }
      ];
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

async function createBrandingBootstrap(config, options) {
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

  const clientConfig = await loadClientInstanceConfigFromFile(configPath);
  const branding = createClientBranding(clientConfig);
  return {
    script: createThemeBootstrapScript(branding.defaultThemeMode),
    style: createThemeBootstrapStyle(branding)
  };
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
