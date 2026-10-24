import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import starlight from "@astrojs/starlight";

// The site is published at https://docs.workshape.ai/catalyst. The host may carry the docs of
// other products beside it, so everything of this site lives under the base path.
const site = "https://docs.workshape.ai";
const base = "/catalyst";

// Pages link to each other from the root of the docs ("/configure/modules/"). Markdown links
// are not rewritten for a base path, so this puts the base in front of every such link.
function rehypeBaseLinks() {
  const visit = (node) => {
    const href =
      node.type === "element" && node.tagName === "a" ? node.properties?.href : undefined;
    if (typeof href === "string" && href.startsWith("/") && !href.startsWith("//")) {
      node.properties.href = `${base}${href}`;
    }
    node.children?.forEach(visit);
  };
  return visit;
}

export default defineConfig({
  site,
  base,
  // The build output is the root of the host: the site in its base folder, and beside it the
  // files of `host/` that have to sit at the root (robots.txt, the redirect from "/").
  outDir: `./dist${base}`,
  markdown: { processor: unified({ rehypePlugins: [rehypeBaseLinks] }) },
  vite: {
    css: {
      postcss: {
        plugins: [
          {
            postcssPlugin: "docs-ui-theme-selectors",
            Rule(rule) {
              if (!rule.source?.input.file?.endsWith("/ui/src/theme/defaults.css")) return;
              // Starlight defaults to dark and gives backdrops their own properties.
              // Light's higher specificity wins over the shared dark base rule.
              if (rule.selector === ":root") {
                rule.selector = ':root[data-theme="light"], [data-theme="light"] ::backdrop';
              } else if (rule.selector === ':root[data-vivd-theme="dark"]') {
                rule.selector = ":root, ::backdrop";
              }
            }
          }
        ]
      }
    }
  },
  // Pages that moved keep their old address.
  redirects: {
    "/operate/rights-and-namespaces": "/catalyst/operate/rights-for-one-person/"
  },
  integrations: [
    starlight({
      title: "Workshape Catalyst",
      description:
        "Documentation for configuring, extending, and running dedicated Workshape Catalyst client instances.",
      // The docs variant of the Catalyst mark: the application's colours swapped, so a docs tab
      // stands apart from an instance tab. It follows the colour scheme itself.
      logo: { src: "./public/favicon.svg", alt: "" },
      routeMiddleware: "./src/route-data.ts",
      customCss: ["./src/styles/theme.css"],
      // Code is highlighted with the themes the chat interface uses, on the site's own surfaces.
      expressiveCode: {
        themes: ["github-dark", "github-light"],
        useStarlightUiThemeColors: true,
        styleOverrides: { borderRadius: "8px" }
      },
      sidebar: [
        {
          label: "Get started",
          items: [
            "start/first-conversation",
            "start/workshaper",
            "start/workspaces",
            "getting-started/local-agent",
            "reference/glossary"
          ]
        },
        {
          label: "Build agents and Apps",
          items: [
            "configure/build",
            "automate/apps",
            "apps/app-or-workflow",
            {
              label: "Build an App",
              items: [
                "apps/build",
                "apps/sandbox",
                "apps/actions",
                "apps/connection-actions",
                "apps/data-store-actions",
                "apps/workflow-actions",
                "apps/examples",
                "apps/troubleshooting"
              ]
            }
          ]
        },
        {
          label: "Automate",
          items: ["automate/workflows"]
        },
        {
          label: "Connect systems",
          items: ["connect/connect-a-system"]
        },
        {
          label: "How it works",
          items: ["how-it-works/rights"]
        },
        {
          label: "Manage",
          items: [
            "operate/how-rights-work",
            "operate/rights-for-one-person",
            "manage/guardrails",
            "operate/governance",
            "operate/usage-by-person"
          ]
        },
        {
          label: "For operators and developers",
          items: [
            {
              label: "Set up an instance",
              items: [
                "getting-started/overview",
                "getting-started/operating-models",
                "operate/instance-brief",
                "operate/deployment",
                "operate/operated-instances",
                "operate/capacity-and-limits",
                "operate/auth-and-embedding",
                "operate/execution-workspaces",
                "operate/runner-security"
              ]
            },
            {
              label: "Configure",
              items: [
                "configure/client-assembly",
                "configure/release-config",
                "configure/modules",
                "configure/config-assets",
                "configure/cli",
                { label: "CLI commands", items: [{ autogenerate: { directory: "configure/cli" } }] }
              ]
            },
            {
              label: "Extend with code",
              items: ["extend/custom-tools", "reference/app-bridge"]
            },
            {
              label: "Run locally",
              items: ["getting-started/local-demo", "getting-started/execution-workspaces-local"]
            },
            {
              label: "Reference",
              items: [
                "reference/current-status",
                {
                  // Written by scripts/generate-api-reference.mjs from the release's OpenAPI document.
                  label: "API",
                  collapsed: true,
                  items: [{ autogenerate: { directory: "reference/api" } }]
                }
              ]
            }
          ]
        }
      ]
    })
  ]
});
