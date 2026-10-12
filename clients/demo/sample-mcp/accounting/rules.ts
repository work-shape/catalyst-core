// The rules a check of a month's bookings applies, and the only place a rule is worded. The
// sample plants bookings that break them (see postings.ts) and the list is data, because the
// rule set of a real client replaces it. A sentence is written so that two people who read it
// write the same check: it names the fields, the values and what counts as one finding.
//
// "Expense account" and "revenue account" mean the `account_class` that `list_accounts` names
// for the booking's `account_number`. "Empty" means the empty string.

export const ACCOUNTING_RULES = {
  "duplicate-posting": {
    de: "Eine Buchung ist ein Befund, wenn eine frühere Buchung desselben Mandanten und Monats dasselbe Belegdatum, Konto, Gegenkonto, denselben Umsatz, dasselbe Belegfeld 1 und denselben Buchungstext hat. Die erste Buchung einer solchen Gruppe ist kein Befund, jede weitere ist ein Befund.",
    en: "A booking is a finding when an earlier booking of the same client and month has the same date, account, contra account, amount, document field 1 and posting description. The first booking of such a group is no finding; each further one is one finding.",
    parameters: {
      fields: [
        "date",
        "account_number",
        "contra_account_number",
        "amount",
        "document_field_1",
        "posting_description"
      ]
    }
  },
  "vat-key-account-mismatch": {
    de: "Eine Buchung ist ein Befund, wenn ihr BU-Schlüssel ein Vorsteuerschlüssel ist und ihr Konto ein Erlöskonto, oder wenn ihr BU-Schlüssel ein Umsatzsteuerschlüssel ist und ihr Konto ein Aufwandskonto.",
    en: "A booking is a finding when its accounting transaction key is an input VAT key and its account is a revenue account, or when its key is a VAT key and its account is an expense account.",
    parameters: { inputVatKeys: [8, 9], vatKeys: [2, 3] }
  },
  "blocked-account": {
    de: "Eine Buchung ist ein Befund, wenn ihr Konto oder ihr Gegenkonto im Kontenplan des Mandanten gesperrt ist.",
    en: "A booking is a finding when its account or its contra account is blocked in the client's chart of accounts.",
    parameters: {}
  },
  "round-amount-no-document": {
    de: "Eine Buchung ist ein Befund, wenn ihr Belegfeld 1 leer ist und ihr Umsatz mindestens den Schwellenwert erreicht und ein ganzes Vielfaches des Rundungsbetrags ist.",
    en: "A booking is a finding when its document field 1 is empty and its amount is at least the threshold and a whole multiple of the rounding unit.",
    parameters: { thresholdEuros: 1_000, roundingUnitEuros: 100 }
  },
  "date-outside-month": {
    de: "Eine Buchung ist ein Befund, wenn ihr Belegdatum vor dem ersten oder nach dem letzten Tag des abgefragten Monats liegt.",
    en: "A booking is a finding when its date lies before the first or after the last day of the requested month.",
    parameters: {}
  },
  "expense-in-credit": {
    de: "Eine Buchung ist ein Befund, wenn ihr Konto ein Aufwandskonto ist, ihr Soll/Haben-Kennzeichen H lautet und sie keine Generalumkehr ist (general_reversal 0).",
    en: "A booking is a finding when its account is an expense account, its debit/credit indicator is H and it is no general reversal (general_reversal 0).",
    parameters: {}
  },
  "missing-cost-centre": {
    de: "Eine Buchung ist ein Befund, wenn ihr Konto ein Aufwandskonto ist, ihr KOST1 leer ist und mindestens eine Buchung desselben Mandanten und Monats ein KOST1 trägt.",
    en: "A booking is a finding when its account is an expense account, its kost1 is empty and at least one booking of the same client and month carries a kost1.",
    parameters: {}
  }
} as const satisfies Record<string, { de: string; en: string; parameters: object }>;

export type AccountingRuleId = keyof typeof ACCOUNTING_RULES;
