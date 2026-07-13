import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClientBranding,
  loadClientInstanceConfigFromFile
} from "@vivd-catalyst/config-schema";

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
  const configPathInput =
    options.clientConfigPath ?? process.env.CLIENT_CONFIG_PATH ?? DEFAULT_CLIENT_CONFIG_PATH;
  const explicitConfigPath = Boolean(options.clientConfigPath ?? process.env.CLIENT_CONFIG_PATH);
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
  const lightVariables = createThemeVariables(branding.theme, "light");
  const darkVariables = createThemeVariables(branding.darkTheme, "dark");
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

function createThemeVariables(theme, mode) {
  const primaryForeground = readableForeground(theme.accentColor);
  return {
    "--background": theme.surfaceColor,
    "--foreground": theme.textColor,
    "--card": theme.surfaceColor,
    "--card-foreground": theme.textColor,
    "--popover": theme.surfaceColor,
    "--popover-foreground": theme.textColor,
    "--primary": theme.accentColor,
    "--primary-foreground": primaryForeground,
    "--secondary": theme.backgroundColor,
    "--secondary-foreground": theme.textColor,
    "--muted": theme.backgroundColor,
    "--muted-foreground": theme.mutedTextColor,
    "--accent": theme.backgroundColor,
    "--accent-foreground": theme.accentStrongColor,
    "--destructive": mode === "dark" ? "#f87171" : "#b42318",
    "--success": mode === "dark" ? "#34d399" : "#047857",
    "--warning": mode === "dark" ? "#fbbf24" : "#b45309",
    "--info": mode === "dark" ? "#38bdf8" : "#0369a1",
    "--chart-1": mode === "dark" ? "#2dd4bf" : "#0f766e",
    "--chart-2": mode === "dark" ? "#fbbf24" : "#b45309",
    "--chart-3": mode === "dark" ? "#38bdf8" : "#0369a1",
    "--chart-4": mode === "dark" ? "#a78bfa" : "#7c3aed",
    "--chart-5": mode === "dark" ? "#f472b6" : "#be185d",
    "--border": theme.borderColor,
    "--input": theme.borderColor,
    "--ring": theme.accentColor,
    "--sidebar": theme.backgroundColor,
    "--sidebar-foreground": theme.textColor,
    "--sidebar-primary": theme.accentColor,
    "--sidebar-primary-foreground": primaryForeground,
    "--sidebar-accent": theme.surfaceColor,
    "--sidebar-accent-foreground": theme.accentStrongColor,
    "--sidebar-border": theme.borderColor,
    "--sidebar-ring": theme.accentColor
  };
}

function serializeThemeRule(selector, variables) {
  const declarations = Object.entries(variables)
    .map(([name, value]) => `${name}:${safeCssValue(value)};`)
    .join("");
  return `${selector}{${declarations}}`;
}

function safeCssValue(value) {
  const trimmed = String(value).trim();
  if (!/^[#a-zA-Z0-9\s.,()%+/-]+$/u.test(trimmed)) {
    throw new Error(`Unsupported theme CSS value for branding bootstrap: ${trimmed}`);
  }
  return trimmed;
}

function readableForeground(background) {
  const rgb = parseHexColor(background);
  if (!rgb) {
    return "#ffffff";
  }
  const luminance = relativeLuminance(rgb);
  return luminance > 0.56 ? "#071312" : "#ffffff";
}

function parseHexColor(value) {
  const hex = value.trim().replace(/^#/u, "");
  if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/iu.test(hex)) {
    return undefined;
  }
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((character) => `${character}${character}`)
          .join("")
      : hex;
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function relativeLuminance({ r, g, b }) {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
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
