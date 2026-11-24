// @vitest-environment happy-dom

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { AuditActivity, AuditEvent } from "@work-shape/catalyst-api-client";
import { TranslationProvider } from "./support/chat-ui/shared";
import { AuditView } from "@work-shape/catalyst-chat-ui/control-plane";
import { EVENTS } from "@work-shape/catalyst-core";
import { UiRoot, uiLabelsDe } from "@work-shape/catalyst-ui";

// UXA-1b: the audit view shows no event type, reason code or stored id, and every audited event
// has words in both catalogs.

const i18n = join(dirname(fileURLToPath(import.meta.url)), "../packages/chat-ui/src/shared/i18n");
const locales = ["en", "de"] as const;
type Locale = (typeof locales)[number];

/** Each message of every translation file, by locale, as `key` and text. */
function catalog(): Record<Locale, [string, string][]> {
  const found: Record<Locale, [string, string][]> = { en: [], de: [] };
  for (const file of readdirSync(i18n).filter((name) => name.endsWith(".ts"))) {
    const path = join(i18n, file);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
    const visit = (node: ts.Node, locale: Locale | undefined) => {
      if (ts.isPropertyAssignment(node)) {
        const name = node.name.getText(source).replace(/^"|"$/gu, "");
        const next = locales.find((candidate) => candidate === name) ?? locale;
        if (
          next &&
          next === locale &&
          (ts.isStringLiteral(node.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(node.initializer))
        ) {
          found[next].push([name, node.initializer.text]);
          return;
        }
        ts.forEachChild(node, (child) => visit(child, next));
        return;
      }
      ts.forEachChild(node, (child) => visit(child, locale));
    };
    visit(source, undefined);
  }
  return found;
}

// UXA-1b2: the audit view says each activity, event, target and reason in the catalogs' words.
// The server sends the event type, a tool's action and reason codes; a type or code without
// words is said by a generic line. Fails without UXA-1b2: the view showed the server's English
// labels, the raw event types and the reason codes.
describe("plain words in the audit view (UXA-1b2)", () => {
  const messages = catalog();

  it("has words in both catalogs for every audited event", () => {
    const audited = Object.values(EVENTS)
      .filter((event) => event.audited)
      .map((event) => `audit.event.${event.name}`);
    for (const locale of locales) {
      const keys = new Set(messages[locale].map(([key]) => key));
      expect(
        audited.filter((key) => !keys.has(key)),
        locale
      ).toEqual([]);
    }
  });

  it("shows no event type, reason code or target kind, also for ones it has no words for", async () => {
    const text = await germanAuditText([
      activity({
        correlationId: "corr_known",
        type: "connection.discovery_failed",
        outcome: "failed",
        reason: "upstream_unauthorized",
        target: { kind: "conversation", id: "conv_1" },
        evidence: [
          event({ type: "connection.discovery_failed", status: "failed", reason: "INTERNAL" }),
          event({
            type: "operation.completed",
            metadata: { auditAction: "workspace.exec", code: "insufficient_scope" }
          })
        ]
      }),
      activity({
        correlationId: "corr_unknown",
        type: "future_domain.something_new",
        outcome: "denied",
        reason: "SOME_NEW_CODE",
        actor: { kind: "system", label: "System" },
        target: { kind: "future_kind", id: "thing_1" },
        evidence: [
          event({ type: "future_domain.something_new", status: "denied", reason: "a_new_reason" })
        ]
      })
    ]);

    for (const code of [
      "connection.discovery_failed",
      "operation.completed",
      "workspace.exec",
      "future_domain",
      "upstream_unauthorized",
      "insufficient_scope",
      "INTERNAL",
      "SOME_NEW_CODE",
      "a_new_reason",
      "conversation:",
      "conv_1",
      "thing_1",
      "future_kind"
    ]) {
      expect(text).not.toContain(code);
    }
  });
});

// UXA-1b3: "Betrifft" says the title or name the server gave, else the kind alone, never the id
// the row stores. Fails without UXA-1b3: the column showed the subject as stored.
describe("what an audit row is about, in words (UXA-1b3)", () => {
  it("says a title, a name or a kind, never an id or an operation's name", async () => {
    const text = await germanAuditText([
      activity({
        correlationId: "corr_subjects",
        type: "config_asset.published",
        tier: "governance",
        target: { kind: "user", id: "user_ada" },
        evidence: [
          event({
            type: "config_asset.published",
            metadata: { kind: "agent", name: "sales" },
            about: { kind: "agent", title: "Vertriebsassistent" }
          }),
          event({
            type: "config_asset.updated",
            metadata: { kind: "skill", name: "secret-skill" },
            about: { kind: "skill" }
          }),
          event({
            type: "operation.completed",
            subject: "demo.weather_forecast",
            about: { kind: "operation", title: "Wettervorhersage" }
          }),
          event({
            type: "role.updated",
            subject: "admin",
            about: { kind: "role", builtInRole: "admin" }
          }),
          event({ type: "user.updated", subject: "user_ada", about: { kind: "user" } })
        ]
      })
    ]);
    for (const id of ["sales", "secret-skill", "demo.weather_forecast", "user_ada", "corr_"]) {
      expect(text).not.toContain(id);
    }
  });
});

let sequence = 0;

function event(partial: Partial<AuditEvent> & Pick<AuditEvent, "type">): AuditEvent {
  sequence += 1;
  return {
    id: `audit_${sequence}`,
    clientInstanceId: "client_test",
    status: "success",
    correlationId: "corr_evidence",
    createdAt: "2026-10-21T08:00:00.000Z",
    ...partial
  };
}

function activity(
  partial: Partial<AuditActivity> & Pick<AuditActivity, "correlationId" | "type">
): AuditActivity {
  return {
    at: "2026-10-21T08:00:00.000Z",
    tier: "runtime",
    outcome: "success",
    actor: { kind: "user", label: "Ada" },
    eventCount: partial.evidence?.length ?? 1,
    repeatCount: 1,
    evidence: [],
    ...partial
  };
}

/** The German audit view's text with every activity opened to its events. */
async function germanAuditText(auditActivities: AuditActivity[]): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsDe },
        createElement(TranslationProvider, {
          locale: "de",
          children: createElement(AuditView, { auditActivities })
        })
      )
    );
  });
  for (const row of container.querySelectorAll<HTMLButtonElement>("button[data-audit-activity]")) {
    await act(async () => row.click());
  }
  const text = container.textContent ?? "";
  await act(async () => root.unmount());
  container.remove();
  return text;
}
