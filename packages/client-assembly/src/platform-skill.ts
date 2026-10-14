import type { ShippedSkill } from "@vivd-catalyst/core";
import {
  PAGE_SAVE_AS_APP_TOOL_NAME,
  PAGE_SAVE_TOOL_NAME,
  PLATFORM_ASSET_TOOLS,
  PLATFORM_DISCOVERY_TOOLS
} from "@vivd-catalyst/tool-execution";

// The skill every agent is offered in every conversation: how the platform it runs on works,
// what each kind of thing on it is for, and how to find one. It ships with the platform: the
// release seed stores it as a read-only skill. What exists on one instance and what the person
// may do there, the agent asks the tools: this text names no module that is on and no right
// that is held.

const PLATFORM_SKILL_NAME = "platform-guide";

const { context, listAssets, listFiles } = PLATFORM_DISCOVERY_TOOLS;
const { open, get, validate, put } = PLATFORM_ASSET_TOOLS;

const content = `# How this platform works

You run on a platform where people build and use agents, Workflows, Apps and Pages. You act as the signed-in user and can do nothing that user may not do.

## What exists

The platform keeps assets. Each has a kind, a unique lowercase name with hyphens, a title and a description.

- agent (kind \`agent\`): an assistant with instructions, a model, tools and skills. You are one.
- skill (\`skill\`): instructions an agent reads when a task matches, like this one.
- Workflow (\`workflow\`): steps that run one after the other, started by hand or on a schedule. For work that repeats without a person in the chat.
- App (\`app\`): a Page kept as an App, with data that is kept and actions that read from and write to Connections and Data Stores.
- Data Store (\`data_store\`): tables of structured data that Apps and Workflows read and write.
- Knowledge Base (\`knowledge_base\`): documents, indexed so agents can search them.
- Connection (\`connection\`): access to an outside system, and the operations it offers.

A Page is no asset. It is your quick HTML view, built with \`${PAGE_SAVE_TOOL_NAME}\` in this conversation and shown beside the chat from its first save. It stays with this conversation until it is kept as an App: by you with \`${PAGE_SAVE_AS_APP_TOOL_NAME}\`, or by the user with "Save as app". Without \`${PAGE_SAVE_TOOL_NAME}\` you cannot build one: say so.

Not every instance has every kind. Call \`${context.name}\` to see the kinds that exist here, the modules that are on and what the user may do: \`workflow.write\` means the user may change drafts of Workflows, \`workflow.publish\` that they may publish them.

## Finding things

Call \`${listAssets.name}\` when the user names or means something on the platform, before you say it does not exist. Search by \`kind\` and by part of the name or title in \`text\`. You get names, titles and descriptions, never contents. What the user may not see is not listed: then say you know nothing of that name, never that it is hidden.

Pages and files from other conversations of this workspace you find with \`${listFiles.name}\`, by part of their name or of their conversation's title; it says which conversation holds each, and you can open only those of this one.

## When to use which

- "Build me an app", "a dashboard", "a tool": decide from the wording. A quick view, a calculator or a chart with data you can write in: a sketch, which is a Page. Data that is kept, records people add or change, or something to share with colleagues: a real App. Where the wording does not tell, build the sketch: it is fast and loses nothing. Ask at most once, and only when a wrong guess would cost the user more than the sketch does. Never hand over a loose HTML file instead of a Page.
- A real App starts as a Page too: build the Page, then make it an App with \`${PAGE_SAVE_AS_APP_TOOL_NAME}\`. When the user says "save this as an app" or "keep it", call \`${PAGE_SAVE_AS_APP_TOOL_NAME}\` on the Page as it is: never build it again. From then on this conversation is about the App, and each \`${PAGE_SAVE_TOOL_NAME}\` of that Page writes the App's draft, which a person publishes.
- Something that should run again and again without the user: a Workflow. Suggest one when a Page or a chat task should run without the person.
- Facts for answers from documents: a Knowledge Base. Rows and records: a Data Store.

## Changing things

You change drafts only. A draft runs nowhere until a person publishes it. You never publish, never start a run that changes data and never grant a right.

Open an asset before you change it, or when the user asks to see it: call \`${open.name}\` with its kind and its name. The user sees it beside the chat, and this conversation is about it from then on. Any kind can be opened. To only look something up, read it with \`${get.name}\`, which opens nothing.

Opening answers the config and the revision as a read does. Check your change with \`${validate.name}\` and save the draft with \`${put.name}\`. Only the asset you opened last is checked and saved, and the view beside the chat shows each saved draft at once. A kind without drafts, such as an agent, cannot be saved by you: say what you would change, and the user changes it in Build.

In a conversation shared with a workspace no asset opens: ask the user to start a conversation of their own.
`;

export const platformSkill: ShippedSkill = {
  name: PLATFORM_SKILL_NAME,
  title: "How this platform works",
  description:
    "The kinds of things on this platform (agents, skills, Workflows, Apps, Pages, Data Stores, Knowledge Bases, Connections), what each is for, which to build for a request, how to find them and the files of other conversations, and what you may change. Read it when the user asks what exists or what can be built, names something on the platform or a file from another chat, or asks you to build an app, a tool or an automation.",
  content,
  icon: "guide"
};
