// What the tile says, in the two languages of the interface.
const en = {
  title: "Customers",
  refresh: "Refresh",
  name: "Name",
  segment: "Segment",
  city: "City",
  shown: (rows: number, total: number) => `${rows} of ${total} customers`,
  empty: "The Connection answered no customer.",
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
  failed: "Die Kunden konnten nicht geladen werden.",
  segments: { retail: "Einzelhandel", hospitality: "Gastgewerbe", office: "Büro" }
};

export type Texts = typeof en;

export function textsFor(locale: string): Texts {
  return locale.toLowerCase().startsWith("de") ? de : en;
}
