---
title: Nutzung pro Person – Information für den Betriebsrat
description: Was Workshape Catalyst pro Person über die Nutzung von KI-Modellen festhält, wer es sehen kann und wie lange es gespeichert bleibt. In einfachem Deutsch, zum Weitergeben.
---

Diese Seite beschreibt, was eine Catalyst-Instanz über die Nutzung von KI-Modellen pro Person festhält, wer diese Angaben sehen kann und wie lange sie gespeichert bleiben. Sie ist zum Weitergeben gedacht, zum Beispiel an einen Betriebsrat oder an die Datenschutzbeauftragte eines Unternehmens.

Diese Seite ist eine Produktbeschreibung und keine Rechtsberatung. Ob eine Betriebsvereinbarung nötig ist (§ 87 Abs. 1 Nr. 6 BetrVG), klären das Unternehmen, sein Betriebsrat und gegebenenfalls ein Anwalt.

## Warum überhaupt pro Person gezählt wird

Ein Unternehmen kann für jede Person ein Ausgabenlimit pro Tag und pro Monat setzen. Damit das Limit greifen kann, zählt Catalyst zusammen, was die eigenen Anfragen einer Person gekostet haben. Das ist der Zweck dieser Zahlen.

## Was pro Aufruf eines KI-Modells festgehalten wird

Jeder Aufruf eines KI-Modells wird als Nutzungsdatensatz gespeichert, mit:

- dem Zeitpunkt des Aufrufs,
- dem Modell und dem Anbieter,
- der Zahl der Tokens und den Kosten,
- dem Agenten, der App oder dem Workflow, der den Aufruf gemacht hat,
- dem Arbeitsbereich, in dem er stattfand,
- der Kennung der Person, die ihn ausgelöst hat.

Der Inhalt der Unterhaltung steht nicht im Nutzungsdatensatz.

## Wer was sehen kann

| Wer | Was |
| --- | --- |
| Jede Person | Ihre eigene Nutzung und ihre eigenen Limits. |
| Wer Limits verwaltet | Welche Personen ihr Limit erreicht haben oder kurz davor sind, mit dem Limit und dem Anteil in Prozent. Das ist nötig, um ein Limit anzupassen. |
| Wer die Nutzung der Instanz sehen darf | Summen nach Arbeitsbereich, Agent, App, Workflow, Modell und Herkunft. Keine Namen von Personen. Alle persönlichen Arbeitsbereiche zusammen erscheinen als eine einzige Zeile „Persönliche Arbeitsbereiche“. Die Liste der letzten Aufrufe nennt den Arbeitsbereich, aber nie die Person; ein Aufruf in einem persönlichen Arbeitsbereich erscheint als „Persönlicher Arbeitsbereich“. |
| Inhaber und Admins eines gemeinsamen Arbeitsbereichs | Was dieser Arbeitsbereich verbraucht hat, nach Agent, App, Workflow, Modell und Herkunft. Keine Zahlen pro Mitglied, solange sie nicht das Recht „Nutzung pro Person ansehen“ für diesen Arbeitsbereich erhalten haben. |
| Wer das Recht „Nutzung pro Person ansehen“ hat | Monatssummen pro Person mit Namen: für die ganze Instanz, oder nur für die Mitglieder eines Arbeitsbereichs, wenn das Recht nur für diesen gilt. |

Die Rollen Admin und Superadmin haben das Recht „Nutzung pro Person ansehen“ von Anfang an. Alle anderen erhalten es nur, wenn es ihnen ausdrücklich gegeben wird.

## Was nicht gezeigt wird

- Keine Uhrzeiten der Aktivität einer Person, kein „zuletzt aktiv“ und keine Verläufe pro Stunde.
- Keine Ranglisten: Die Ansicht pro Person ist nach Namen sortiert, nicht nach Verbrauch.
- Keine Zahl der Rückmeldungen (Feedback) pro Person.

## Was protokolliert wird

- Wer einer Person das Recht „Nutzung pro Person ansehen“ gibt oder nimmt, steht im Audit-Log.
- Jedes Öffnen der Ansicht pro Person steht im Audit-Log: wer sie geöffnet hat, für welchen Monat und für welchen Arbeitsbereich. Die gezeigten Zahlen und Namen stehen nicht darin.

## Wie lange die Angaben bleiben

- Die Beträge, Tokens, Modelle, Agenten und Arbeitsbereiche bleiben als Abrechnungsdaten erhalten.
- Die Kennung der Person wird aus den Nutzungsdatensätzen entfernt, wenn ihr Konto gelöscht wird. Die Beträge bleiben, ohne Bezug zur Person.
- Vorgesehen ist außerdem, dass die Kennung der Person nach drei Monaten aus den Nutzungsdatensätzen entfernt wird, mit einer Dauer, die jede Instanz anders einstellen kann.

:::caution[Stand dieser Version]
Das automatische Entfernen der Kennung nach drei Monaten und die Einstellung seiner Dauer sind in dieser Version noch nicht enthalten. Bis es ausgeliefert ist, wird die Kennung nur beim Löschen eines Kontos entfernt.
:::
