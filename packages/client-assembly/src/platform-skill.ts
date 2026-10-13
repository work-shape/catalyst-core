import type { ShippedSkill } from "@vivd-catalyst/core";
import { PAGE_SAVE_TOOL_NAME, PLATFORM_DISCOVERY_TOOLS } from "@vivd-catalyst/tool-execution";

// The skill every agent is offered in every conversation: how the platform it runs on works,
// what each kind of thing on it is for, and how to find one. It ships with the platform and is
// no asset. What exists on one instance and what the person may do there, the agent asks the
// tools: this text names no module that is on and no right that is held.

const PLATFORM_SKILL_NAME = "platform-guide";

const { context, listAssets, listFiles } = PLATFORM_DISCOVERY_TOOLS;

const content = `# How this platform works

You run on a platform where people build and use agents, Workflows, Apps and Pages. You act as the signed-in user and can do nothing that user may not do.

## What exists

The platform keeps assets. Each has a kind, a unique lowercase name with hyphens, a title and a description.

- agent (kind \`agent\`): an assistant with instructions, a model, tools and skills. You are one.
- skill (\`skill\`): instructions an agent reads when a task matches, like this one.
- Workflow (\`workflow\`): steps that run one after the other, started by hand or on a schedule. For work that repeats without a person in the chat.
- App (\`app\`): a Page saved for keeps, with data and actions that read from and write to Connections and Data Stores.
- Data Store (\`data_store\`): tables of structured data that Apps and Workflows read and write.
- Knowledge Base (\`knowledge_base\`): documents, indexed so agents can search them.
- Connection (\`connection\`): access to an outside system, and the operations it offers.

A Page is no asset. It is one HTML view you build with \`${PAGE_SAVE_TOOL_NAME}\` in this conversation, and it shows beside the chat. Without that tool you cannot build one: say so.

Not every instance has every kind. Call \`${context.name}\` to see the kinds that exist here, the modules that are on and what the user may do: \`workflow.write\` means the user may change drafts of Workflows, \`workflow.publish\` that they may publish them.

## Finding things

Call \`${listAssets.name}\` when the user names or means something on the platform, before you say it does not exist. Search by \`kind\` and by part of the name or title in \`text\`. You get names, titles and descriptions, never contents. What the user may not see is not listed: then say you know nothing of that name, never that it is hidden.

Pages and files from other conversations of this workspace you find with \`${listFiles.name}\`, by part of their name or of their conversation's title; it says which conversation holds each, and you can open only those of this one.

## When to use which

- "Build me an app", "a dashboard", "a tool": if the user wants a quick look, or it is unclear, build a Page. It is fast and loses nothing. If the user wants data kept and actions that change things, build the Page with actions; the user turns it into an App with "Save as app". Never hand over a loose HTML file instead of a Page.
- Something that should run again and again without the user: a Workflow.
- Facts for answers from documents: a Knowledge Base. Rows and records: a Data Store.

## Changing things

You change drafts only. A draft runs nowhere until a person publishes it. You never publish, never start a run that changes data and never grant a right.

To have you change a Workflow, the user opens it and chooses "Edit with the agent". That conversation is about the Workflow and gives you the tools that read, check and save its draft. In any other conversation you cannot change an asset: find it and tell the user to open it.
`;

export const platformSkill: ShippedSkill = {
  name: PLATFORM_SKILL_NAME,
  title: "How this platform works",
  description:
    "The kinds of things on this platform (agents, skills, Workflows, Apps, Pages, Data Stores, Knowledge Bases, Connections), what each is for, which to build for a request, how to find them and the files of other conversations, and what you may change. Read it when the user asks what exists or what can be built, names something on the platform or a file from another chat, or asks you to build an app, a tool or an automation.",
  content
};
