// What the tile says, in the two languages of the interface.
const en = {
  title: "Customers",
  refresh: "Refresh",
  name: "Name",
  segment: "Segment",
  city: "City",
  shown: (rows: number, total: number) => `${rows} of ${total} customers`,
  empty: "The Connection answered no customer.",
  forbidden: (right: string) =>
    `You may not read these rows. You lack the right '${right}' on the Connection. An administrator can grant it.`,
  failed: "The customers could not be loaded.",
  segments: { retail: "Retail", hospitality: "Hospitality", office: "Office" }
};

const de: typeof en = {
  title: "Kunden",
  refresh: "Aktualisieren",
  name: "Name",
  segment: "Segment",
  city: "Ort",
  shown: (rows, total) => `${rows} von ${total} Kunden`,
  empty: "Die Verbindung hat keinen Kunden geliefert.",
  forbidden: (right) =>
    `Sie dürfen diese Zeilen nicht lesen. Ihnen fehlt das Recht '${right}' an der Verbindung. Ein Administrator kann es vergeben.`,
  failed: "Die Kunden konnten nicht geladen werden.",
  segments: { retail: "Einzelhandel", hospitality: "Gastgewerbe", office: "Büro" }
};

export type Texts = typeof en;

export function textsFor(locale: string): Texts {
  return locale.toLowerCase().startsWith("de") ? de : en;
}
