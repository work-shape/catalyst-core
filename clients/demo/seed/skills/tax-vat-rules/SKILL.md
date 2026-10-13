---
name: tax-vat-rules
title: "Umsatzsteuer: Pflichtangaben"
description: Nutzen, wenn eine Rechnung auf Pflichtangaben oder den Steuersatz geprüft wird.
summary: Weiß, wie man eine Rechnung auf Pflichtangaben und den Steuersatz prüft.
starters:
  - title:
      de: Rechnung prüfen
      en: Check an invoice
    hint:
      de: Pflichtangaben und Steuersatz
      en: Required details and tax rate
    prompt:
      de: "Prüfe diese Rechnung auf Pflichtangaben und den richtigen Steuersatz:"
      en: "Check this invoice for the required details and the right tax rate:"
---

# Umsatzsteuer: Pflichtangaben

Eine Rechnung über 250 Euro braucht:

- Name und Anschrift von leistendem Unternehmen und Empfänger
- Steuernummer oder Umsatzsteuer-Identifikationsnummer
- Ausstellungsdatum und fortlaufende Rechnungsnummer
- Menge und Art der Leistung, Zeitpunkt der Leistung
- Entgelt nach Steuersätzen getrennt, Steuersatz und Steuerbetrag

## Reverse Charge

Bei sonstigen Leistungen an ein Unternehmen im EU-Ausland schuldet der Empfänger die Steuer. Die Rechnung weist dann keine Umsatzsteuer aus und trägt den Hinweis "Steuerschuldnerschaft des Leistungsempfängers" sowie beide Umsatzsteuer-Identifikationsnummern.
