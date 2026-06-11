import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    starlight({
      title: "Data Chat Operator Docs",
      description:
        "Documentation for configuring, extending, and running dedicated Data Chat client instances.",
      sidebar: [
        {
          label: "Start Here",
          items: [
            "getting-started/overview",
            "getting-started/operating-models",
            "getting-started/local-demo",
          ],
        },
        {
          label: "Configure A Client Instance",
          items: [
            "configure/client-assembly",
            "configure/release-config",
            "configure/chat-experience",
          ],
        },
        {
          label: "Extend The Agent",
          items: ["extend/custom-tools", "extend/openapi-tools"],
        },
        {
          label: "Run And Govern",
          items: [
            "operate/deployment",
            "operate/auth-and-embedding",
            "operate/governance",
            "operate/instance-brief",
          ],
        },
        {
          label: "Reference",
          items: [
            "reference/current-status",
            "reference/framework-choice",
            "reference/glossary",
          ],
        },
      ],
    }),
  ],
});
