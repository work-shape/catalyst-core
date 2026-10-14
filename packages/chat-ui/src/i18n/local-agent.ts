import { defineTranslations } from "./translation-area";

/** You > Connect a local agent: the command that connects Claude Code, Codex or another tool. */
export const localAgent = defineTranslations({
  en: {
    "settings.connectLocalAgent": "Connect a local agent",
    "localAgent.description":
      "Let Claude Code, Codex or another AI tool on your computer work with Catalyst as you.",
    "localAgent.tool": "Your tool",
    "localAgent.other": "Other",
    "localAgent.otherTool": "your tool",
    "localAgent.command": "Run this in a terminal",
    "localAgent.commandHint": "It needs Node 22 or later.",
    "localAgent.commandLabel": "Command for {tool}",
    "localAgent.next": "What happens next",
    "localAgent.nextDescription":
      "Your browser shows a code to confirm. You tick what the key may do, and {tool} gets a skill that teaches it Catalyst.",
    "localAgent.keysLink": "See or revoke the key"
  },
  de: {
    "settings.connectLocalAgent": "Lokalen Agenten verbinden",
    "localAgent.description":
      "Lass Claude Code, Codex oder ein anderes KI-Werkzeug auf deinem Computer als du mit Catalyst arbeiten.",
    "localAgent.tool": "Dein Werkzeug",
    "localAgent.other": "Andere",
    "localAgent.otherTool": "dein Werkzeug",
    "localAgent.command": "Führe das in einem Terminal aus",
    "localAgent.commandHint": "Es braucht Node 22 oder neuer.",
    "localAgent.commandLabel": "Befehl für {tool}",
    "localAgent.next": "Was dann passiert",
    "localAgent.nextDescription":
      "Dein Browser zeigt einen Code zum Bestätigen. Du wählst, was der Schlüssel darf, und {tool} bekommt einen Skill, der ihm Catalyst beibringt.",
    "localAgent.keysLink": "Schlüssel ansehen oder widerrufen"
  }
});
