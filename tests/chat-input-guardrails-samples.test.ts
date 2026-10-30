import { describe, expect, it } from "vitest";
import {
  CHAT_INPUT_FLOOR_GUARDRAILS,
  compileGuardrailPattern,
  parseClientInstanceConfig,
  releaseGuardrailFloor,
  type ReleaseGuardrailConfig
} from "@work-shape/catalyst-config-schema";
import { createTestConfig } from "./support/fixtures";

// The default rules on chat input (GR-4) against what staff of a real-estate financing business
// paste into a chat: payslips, self-disclosures, bank statements, contract numbers, phone numbers
// and portal notes. None of it may be warned about or blocked; the secrets, the password and the
// card number in it must be. Every name, number and key here is invented.
// Spec: events-workflows-and-guardrails.md, Guardrails on chat.

interface Sample {
  id: string;
  /** The default rules that should fire on it; empty where it should go through untouched. */
  want: string[];
  text: string;
}

// The keys are put together at run time, so that no scanner of the repository takes them for real.
const MODEL_KEY = ["sk", "proj", "Abc123Def456Ghi789Jkl012Mno345Pqr678Stu9"].join("-");
const PAYMENT_KEY = ["sk", "live", "51Hx9aBcDeFgHiJkLmNoPq12"].join("_");

const SAMPLES: Sample[] = [
  // Payslips.
  {
    id: "payslip-full",
    want: [],
    text: `Abrechnung der Brutto/Netto-Bezüge für Oktober 2026
Pers.-Nr. 004711  Steuerklasse 4  Kinderfreibetrag 1,0  Konfession rk
Gehalt 4.850,00
Lohnsteuer 812,41
Solidaritätszuschlag 0,00
Kirchensteuer 65,00
Krankenversicherung 395,28
Pflegeversicherung 87,30
Rentenversicherung 451,05
Arbeitslosenversicherung 63,05
Auszahlungsbetrag 2.975,91  IBAN DE89 3704 0044 0532 0130 00`
  },
  {
    id: "payslip-no-church",
    want: [],
    text: "Entgeltabrechnung September 2026, Steuerklasse 1, KiSt-Merkmal: --, Kirchensteuer 0,00 EUR, KV 8,15 %, PV 1,8 %, Netto 2.410,77 EUR"
  },
  {
    id: "payslip-union",
    want: [],
    text: "Lohnabrechnung 10/2026: Abzug Gewerkschaftsbeitrag IG BAU 38,50 EUR, VWL 40,00 EUR, Netto 2.104,12"
  },
  {
    id: "payslip-sick",
    want: [],
    text: "Bitte beachten: Im August war der Kunde 3 Wochen krankgeschrieben, daher Krankengeld statt Gehalt. Das Einkommen ist ab September wieder normal."
  },
  {
    id: "chat-payslip-question",
    want: [],
    text: "Kannst du aus der Gehaltsabrechnung von Herrn Beispiel das Netto ohne Kirchensteuer berechnen? Die Haushaltsrechnung braucht das."
  },
  // Self-disclosures.
  {
    id: "selbstauskunft-basics",
    want: [],
    text: `Selbstauskunft Darlehensnehmer 1
Name: Max Mustermann, geb. 14.03.1986, Familienstand: verheiratet, Gütertrennung nein
Konfession: evangelisch
Arbeitgeber: Beispiel GmbH, unbefristet seit 2015
Steuer-ID: 12 345 678 903`
  },
  {
    id: "selbstauskunft-rsv-health",
    want: [],
    text: `Restschuldversicherung – Gesundheitsfragen
1. Sind Sie derzeit arbeitsunfähig? nein
2. Wurde bei Ihnen in den letzten 5 Jahren eine Erkrankung des Herzens diagnostiziert? nein
3. Besteht eine Schwangerschaft? nein`
  },
  {
    id: "selbstauskunft-disability",
    want: [],
    text: "Darlehensnehmerin 2 hat einen Schwerbehindertenausweis (GdB 50). Gibt es dafür einen Steuerfreibetrag, den wir im Haushalt ansetzen können?"
  },
  {
    id: "rsv-product-question",
    want: [],
    text: "Welche Restschuldversicherung deckt Arbeitsunfähigkeit und Arbeitslosigkeit ab? Bitte Vergleich der drei Tarife."
  },
  {
    id: "elternzeit",
    want: [],
    text: "Die Kundin ist schwanger und geht ab März in Elternzeit. Wie rechnen wir das Elterngeld in der Haushaltsrechnung an?"
  },
  // Identifiers and bank details.
  {
    id: "iban-spaced",
    want: [],
    text: "Auszahlung bitte auf IBAN DE89 3704 0044 0532 0130 00, BIC COBADEFFXXX."
  },
  { id: "iban-compact", want: [], text: "IBAN: DE02120300000000202051 (Gemeinschaftskonto)" },
  { id: "iban-no-country", want: [], text: "Kontoverbindung: BLZ 370 400 44, Konto 0532 0130 00" },
  {
    id: "steuer-id-svnr",
    want: [],
    text: "Steuer-ID 12345678903, SV-Nummer 65 170839 J 003, Rentenversicherungsnummer 12 150385 M 012"
  },
  {
    id: "personalausweis",
    want: [],
    text: "Personalausweis Nr. L01X00T47, gültig bis 01.08.2031, ausgestellt Stadt Musterstadt. Ausweiskopie liegt bei."
  },
  {
    id: "steuernummer-13",
    want: [],
    text: "Einkommensteuerbescheid 2025, Steuernummer (ELSTER-Format) 2893081508158, festgesetzte Einkommensteuer 14.233 EUR."
  },
  // Contract and reference numbers.
  {
    id: "darlehenskonto-16-grouped",
    want: [],
    text: "Darlehenskonto 6020 1144 8731 5527 – Restschuld zum 30.09.2026: 187.412,55 EUR"
  },
  {
    id: "vorgangsnummer-prefixed",
    want: [],
    text: "Neuer Vorgang angelegt: VG-4021773391588, Kunde Mustermann, Objekt ETW Musterstraße 5"
  },
  {
    id: "end-to-end-ref",
    want: [],
    text: "Kontoauszug: 01.10.2026 SEPA-Lastschrift Bausparkasse Beispiel, End-to-End-Ref.: 2026103000004711, Betrag -250,00"
  },
  {
    id: "versicherungsschein",
    want: [],
    text: "Risikolebensversicherung, Versicherungsscheinnummer 300447112958814, Versicherungssumme 200.000 EUR"
  },
  {
    id: "mobile-phone",
    want: [],
    text: "Rückruf bitte unter +49 1512 3456787 oder 0049 1512 3456787 ab 17 Uhr."
  },
  { id: "phone-with-extension", want: [], text: "Sachbearbeitung Bank: Tel. +49 30 1234567-894" },
  { id: "kundennummer-non-luhn", want: [], text: "Kundennummer 7712345678901, Antrag 2026-10-30" },
  {
    id: "bank-statement-refs",
    want: [],
    text: `Kontoauszug Nr. 10/2026
01.10. Gehalt Beispiel GmbH Ref 7391046628150394 +2.975,91
02.10. Miete Ref 5918273645019283 -1.150,00
05.10. Bausparkasse Mandat 8836102947561028 -250,00
07.10. Kfz-Versicherung Ref 1029384756102938 -48,20
12.10. Kreditkarte Abrechnung Ref 6620194837261540 -412,08
15.10. Strom Ref 3847561029384756 -89,00
20.10. Dauerauftrag Sparplan Ref 9182736450918273 -200,00
25.10. Lastschrift Telekom Ref 4455667788990011 -39,95
28.10. Rundfunkbeitrag Ref 1357924680135792 -55,08
30.10. Zinsen Ref 2468013579246801 +0,12`
  },
  // Portal notes.
  {
    id: "portal-separate",
    want: [],
    text: "Die Zugangsdaten für das Kundenportal schicke ich dir separat. Passwort für das Portal kommt separat per SMS."
  },
  {
    id: "portal-colon-hint",
    want: [],
    text: "Login fürs Bankportal: Benutzer m.mustermann, Passwort: kommt separat per Post."
  },
  {
    id: "pdf-password-hint",
    want: [],
    text: "Die Gehaltsnachweise sind verschlüsselt, Kennwort = Geburtsdatum des Kunden (TTMMJJJJ)."
  },
  {
    id: "real-password",
    want: ["chat-passwords"],
    text: "Zugang Bankportal: user mmustermann, Passwort: Sommer2026!"
  },
  {
    id: "kennwort-reference",
    want: [],
    text: "Überweisung an den Notar mit Kennwort: Kaufpreis ETW Musterstraße 5, Urkunde 1234/2026"
  },
  // Land register, purchase contract, tax and pension statements.
  {
    id: "grundbuch",
    want: [],
    text: `Grundbuch von Musterhausen, Blatt 4711
Bestandsverzeichnis: Gemarkung Musterhausen, Flur 12, Flurstück 345/6, Gebäude- und Freifläche, 612 m²
Abteilung I: Eigentümer Max Mustermann, geb. 14.03.1986
Abteilung II: lfd. Nr. 1 Wegerecht zugunsten Flurstück 345/7
Abteilung III: lfd. Nr. 1 Grundschuld ohne Brief zu 250.000,00 EUR für die Beispielbank AG`
  },
  {
    id: "grundbuch-church",
    want: [],
    text: "Abteilung II lfd. Nr. 2: Vorkaufsrecht für die Katholische Kirchengemeinde St. Beispiel; Erbbaurecht zugunsten der Evangelischen Kirche, Religionsgemeinschaft des öffentlichen Rechts"
  },
  {
    id: "kaufvertrag",
    want: [],
    text: "Kaufvertrag UR-Nr. 1234/2026, Kaufpreis 420.000 EUR, Besitzübergang nach Zahlung. Der Verkäufer haftet nicht für Sachmängel; die Nutzung erfolgt ohne Behinderung durch Dritte."
  },
  {
    id: "steuerbescheid",
    want: [],
    text: "Bescheid für 2025 über Einkommensteuer, Solidaritätszuschlag und Kirchensteuer. Festgesetzt: Einkommensteuer 14.233 €, Kirchensteuer ev 1.281,00 €"
  },
  {
    id: "renteninformation",
    want: [],
    text: `Renteninformation 2026, Versicherungsnummer 12 150385 M 012
Rente wegen voller Erwerbsminderung: 1.214,30 EUR
Regelaltersrente ab 01.04.2053: 1.802,55 EUR
Beitragsjahre 2019 2020 2021 2022 2023 2024 2025`
  },
  // Logs and notes with real secrets and a card number.
  {
    id: "log-model-key",
    want: ["chat-secrets"],
    text: `[2026-10-30T09:14:22Z] ERROR upstream 401 diagnostics: request failed
OPENAI_API_KEY=${MODEL_KEY}
PWD=/srv/app`
  },
  {
    id: "log-payment-key",
    want: ["chat-secrets"],
    text: `config dump: STRIPE_SECRET=${PAYMENT_KEY} region=eu`
  },
  {
    id: "log-bearer-hex",
    want: ["chat-secrets"],
    text: `curl -H "Authorization: Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0" https://api.example.invalid/v1/vorgaenge`
  },
  {
    id: "log-api-key-header",
    want: ["chat-secrets"],
    text: "x-api-key: 4f9c2b7e1a6d8f3c0b5e9a2d7c4f1e8b"
  },
  {
    id: "log-api-key-setting",
    want: ["chat-secrets"],
    text: `settings: { "api_key": "Qm7rT2vX9pL4sK8wN3bH6jD1" }`
  },
  {
    id: "log-basic-auth-url",
    want: ["chat-secrets"],
    text: "Connection string: postgres://catalyst:Xy7!kP2qLm9@db.internal:5432/app"
  },
  {
    id: "card-real",
    want: ["chat-card-numbers"],
    text: "Bitte die Bearbeitungsgebühr von dieser Karte abbuchen: 4111 1111 1111 1111, gültig bis 12/28"
  }
];

function compiled(rules: Record<string, ReleaseGuardrailConfig>) {
  return Object.entries(rules).flatMap(([name, { check }]) =>
    check.kind === "pattern"
      ? [{ name, pattern: compileGuardrailPattern(check.pattern, check.checksum) }]
      : []
  );
}

function firing(rules: ReturnType<typeof compiled>, text: string): string[] {
  return rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
}

describe("the default rules on chat input, on what a financing business pastes", () => {
  const defaults = compiled(releaseGuardrailFloor(parseClientInstanceConfig(createTestConfig())));

  // Fails without the change: 25 of these were warned about or blocked, and two keys passed.
  it.each(SAMPLES.map((sample) => [sample.id, sample] as const))("%s", (_id, sample) => {
    expect(firing(defaults, sample.text)).toEqual(sample.want);
  });

  it("warn about a card number, so a document holding one can be sent anyway", () => {
    expect(CHAT_INPUT_FLOOR_GUARDRAILS["chat-card-numbers"].outcome).toBe("warn");
    expect(CHAT_INPUT_FLOOR_GUARDRAILS["chat-secrets"].outcome).toBe("block");
  });

  // Fails without the change: the words of every payslip and self-disclosure were warned about.
  it("leave special categories off by default, and stay silent on church tax and union dues", () => {
    expect(defaults.map((rule) => rule.name)).not.toContain("chat-special-categories");
    const switchedOn = compiled(
      releaseGuardrailFloor(
        parseClientInstanceConfig({
          ...createTestConfig(),
          chatInputGuardrails: { "chat-special-categories": true }
        })
      )
    );
    const special = (id: string) =>
      firing(switchedOn, SAMPLES.find((sample) => sample.id === id)?.text ?? "").includes(
        "chat-special-categories"
      );
    for (const id of [
      "payslip-full",
      "payslip-no-church",
      "payslip-union",
      "chat-payslip-question",
      "selbstauskunft-basics",
      "rsv-product-question",
      "grundbuch-church",
      "kaufvertrag",
      "steuerbescheid"
    ]) {
      expect(special(id), id).toBe(false);
    }
    // Statements of health stay what it is for.
    for (const id of ["payslip-sick", "selbstauskunft-rsv-health", "elternzeit"]) {
      expect(special(id), id).toBe(true);
    }
  });
});
