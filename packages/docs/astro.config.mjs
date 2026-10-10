import { defineConfig } from "astro/config";
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
  markdown: { rehypePlugins: [rehypeBaseLinks] },
  integrations: [
    starlight({
      title: "Workshape Catalyst",
      description:
        "Documentation for configuring, extending, and running dedicated Workshape Catalyst client instances.",
      // The mark is the application's own: the file the chat interface ships as its favicon.
      logo: { src: "./public/favicon.svg", alt: "" },
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
            "getting-started/overview",
            "getting-started/operating-models",
            "getting-started/local-demo",
            "getting-started/execution-workspaces-local"
          ]
        },
        {
          label: "Configure",
          items: [
            "configure/client-assembly",
            "configure/release-config",
            "configure/modules",
            "configure/config-assets",
            "configure/chat-experience"
          ]
        },
        {
          label: "Extend",
          items: ["extend/custom-tools", "extend/openapi-tools"]
        },
        {
          label: "Operate",
          items: [
            "operate/instance-brief",
            "operate/deployment",
            "operate/auth-and-embedding",
            "operate/governance",
            "operate/rights-and-namespaces",
            "operate/execution-workspaces",
            "operate/runner-security",
            "operate/config-asset-migration"
          ]
        },
        {
          label: "Reference",
          items: [
            "reference/current-status",
            "reference/glossary",
            {
              // Written by scripts/generate-api-reference.mjs from the release's OpenAPI document.
              label: "API",
              collapsed: true,
              items: [{ autogenerate: { directory: "reference/api" } }]
            }
          ]
        }
      ]
    })
  ]
});
