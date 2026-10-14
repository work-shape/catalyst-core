import type { ShippedSkill } from "@vivd-catalyst/core";
import generated from "./generated/platform-docs.json" with { type: "json" };

// The product's documentation as a skill: one reference file per page of the platform's docs,
// and an index of them as the skill's text. The references are written from the docs pages by
// `pnpm generate:platform-docs`, and a test fails when they differ, so the skill always says
// what the docs of this release say. It is offered only to an agent that holds the platform's
// tools, as is the orientation that points to it.

export const PLATFORM_DOCS_SKILL_NAME = "platform-docs";

/** The sections of the docs, in the order a reader meets them. A new one follows them. */
const SECTION_HEADINGS: ReadonlyMap<string, string> = new Map([
  ["getting-started", "Getting started"],
  ["configure", "Configure"],
  ["apps", "Apps"],
  ["extend", "Extend"],
  ["operate", "Operate"],
  ["reference", "Reference"]
]);

const referencePath = (page: string) => `references/${page}.md`;

/** The section of a page: its first folder, or "Pages" for one at the top. */
const sectionOf = (page: string) =>
  page.includes("/") ? page.slice(0, page.indexOf("/")) : "Pages";

const content = [
  "# Workshape Catalyst documentation",
  "",
  "The product documentation of this platform's release, one reference file per page. Read the page that answers the question with read_skill, naming this skill and the page's path as `resourcePath`. A link in a page such as `/configure/build/` is the reference `references/configure/build.md`.",
  "",
  "The docs describe the product. What exists on this instance and what the user may do here, ask the platform's tools.",
  ...[
    ...new Set([...SECTION_HEADINGS.keys(), ...generated.pages.map(({ path }) => sectionOf(path))])
  ]
    .map((section) => ({
      heading: SECTION_HEADINGS.get(section) ?? section,
      pages: generated.pages.filter((page) => sectionOf(page.path) === section)
    }))
    .filter(({ pages }) => pages.length > 0)
    .flatMap(({ heading, pages }) => [
      "",
      `## ${heading}`,
      "",
      ...pages.map(
        (page) => `- \`${referencePath(page.path)}\`: ${page.title}. ${page.description}`
      )
    ])
].join("\n");

export const platformDocsSkill: ShippedSkill = {
  name: PLATFORM_DOCS_SKILL_NAME,
  title: "Platform documentation",
  description:
    "The product documentation of this platform: agents and skills in Studio, building Apps and their actions, the CLI, release config, modules, rights and Namespaces, tools, deployment, governance and limits. Read it when the user asks how the platform works in detail, how to configure, extend or operate it, or what a term means.",
  content,
  resources: generated.pages.map((page) => ({
    path: referencePath(page.path),
    mediaType: "text/markdown",
    content: `# ${page.title}\n\n${page.description}\n\n${page.body}\n`
  })),
  icon: "guide"
};
