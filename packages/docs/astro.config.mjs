import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Vivd Catalyst Operator Docs",
      description:
        "Documentation for configuring, extending, and running dedicated Vivd Catalyst client instances.",
      sidebar: [
        {
          label: "Start Here",
          items: [
            "getting-started/overview",
            "getting-started/operating-models",
            "getting-started/local-demo",
            "getting-started/execution-workspaces-local"
          ]
        },
        {
          label: "Configure A Client Instance",
          items: [
            "configure/client-assembly",
            "configure/release-config",
            "configure/modules",
            "configure/config-assets",
            "configure/chat-experience"
          ]
        },
        {
          label: "Extend The Agent",
          items: ["extend/custom-tools", "extend/openapi-tools"]
        },
        {
          label: "Run And Govern",
          items: [
            "operate/deployment",
            "operate/config-asset-migration",
            "operate/execution-workspaces",
            "operate/runner-security",
            "operate/auth-and-embedding",
            "operate/governance",
            "operate/rights-and-namespaces",
            "operate/instance-brief"
          ]
        },
        {
          // Written by scripts/generate-api-reference.mjs from the release's OpenAPI document.
          label: "API Reference",
          items: [{ autogenerate: { directory: "reference/api" } }]
        },
        {
          label: "Reference",
          items: ["reference/current-status", "reference/framework-choice", "reference/glossary"]
        }
      ]
    })
  ]
});
