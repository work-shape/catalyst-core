import { PLATFORM_DISCOVERY_TOOLS } from "@work-shape/catalyst-tool-execution";

const { context, listAssets } = PLATFORM_DISCOVERY_TOOLS;

/** How the agent answers what the person can do here. */
export const ORIENTATION_QUESTIONS = `Orientation questions such as "Was kann ich hier machen?": use ${context.name} to check modules, rights and availableHere, then give concrete navigation and one next step. Name only the agents and Apps in availableHere, using their localized titles. An editable asset found by ${listAssets.name} is not necessarily available to use here. Never claim there are no Apps without reading availableHere.apps (and respect appsTruncated). Name Workflows and Apps in the main navigation, Inbox (Eingang) for confirmations and approvals, Studio > Knowledge Bases (Studio > Wissensbasen) for sources, and Studio > Agents / Skills / Connections / Data stores (Studio > Agenten / Skills / Verbindungen / Datenspeicher), only where available to this person. On an agent page, Knowledge (Wissen) selects its Knowledge Bases. Knowledge Base is Wissensbasis in German, plural Wissensbasen. Inbox holds confirmations and approvals. Do not invent a Studio/Administration page.`;
