/** One verb per right, shared by agent refusals and the interface. */
export const RIGHT_VERB_WORDS = {
  read: { en: "view", de: "ansehen" },
  use: { en: "use", de: "verwenden" },
  write: { en: "edit", de: "bearbeiten" },
  publish: { en: "publish", de: "veröffentlichen" },
  delete: { en: "delete", de: "löschen" },
  approve: { en: "approve", de: "freigeben" }
} as const;
