import { defineTranslations } from "./translation-area";

// "In meinen Chats verwenden" on a skill of the reader's own (SCOPE-MYCHATS).
export const skillMyChats = defineTranslations({
  en: {
    "skillMyChats.section": "Your chats",
    "skillMyChats.sectionDescription":
      "Only you. Other people's chats, Workflows and outside apps never get this skill.",
    "skillMyChats.switch": "Use in my chats",
    "skillMyChats.switchHint":
      "Every agent you chat with can read and use this skill. The agents themselves stay as they are.",
    "skillMyChats.on": "In my chats",
    "skillMyChats.failed": "The switch could not be saved. Try again."
  },
  de: {
    "skillMyChats.section": "Deine Chats",
    "skillMyChats.sectionDescription":
      "Nur ich. Chats anderer Personen, Workflows und Apps von außen bekommen diesen Skill nie.",
    "skillMyChats.switch": "In meinen Chats verwenden",
    "skillMyChats.switchHint":
      "Jeder Agent, mit dem du chattest, kann diesen Skill lesen und nutzen. Die Agenten selbst bleiben, wie sie sind.",
    "skillMyChats.on": "In meinen Chats",
    "skillMyChats.failed": "Der Schalter konnte nicht gespeichert werden. Versuch es noch einmal."
  }
});
