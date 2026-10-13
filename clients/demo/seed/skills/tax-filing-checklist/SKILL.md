---
name: tax-filing-checklist
title: Checkliste Abgabefristen
description: Nutzen, wenn Abgabefristen geplant oder fehlende Unterlagen gesucht werden.
summary: Weiß, wie man Abgabefristen plant und fehlende Unterlagen findet.
starters:
  - title:
      de: Fehlende Unterlagen finden
      en: Find missing documents
    hint:
      de: Vor der nächsten Abgabefrist
      en: Before the next filing deadline
    prompt:
      de: Welche Unterlagen fehlen typischerweise vor der Umsatzsteuer-Voranmeldung, und bis wann brauche ich sie?
      en: Which documents are typically missing before the advance VAT return, and by when do I need them?
  # Shows only for an agent that can write files: the starter names the tool it needs.
  - title:
      de: Fristenliste als Datei
      en: Deadlines as a file
    hint:
      de: Eine Liste zum Weitergeben
      en: A list to pass on
    prompt:
      de: Erstelle eine Liste der Abgabefristen dieses Quartals als Datei.
      en: Create a file with this quarter's filing deadlines.
    tools:
      - workspace.write_file
---

# Checkliste Abgabefristen

1. Steuerart und Zeitraum klären.
2. Prüfen, ob eine Dauerfristverlängerung läuft.
3. Fehlende Unterlagen auflisten: Belege, Kontoauszüge, Lohnjournal.
4. Frist nennen und eine Woche Puffer für Rückfragen einplanen.

Umsatzsteuer-Voranmeldungen sind bis zum 10. des Folgemonats fällig, mit Dauerfristverlängerung einen Monat später.
