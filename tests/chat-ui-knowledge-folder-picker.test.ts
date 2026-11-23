// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  KnowledgeSourceFolderPicker,
  type KnowledgeBaseSource
} from "@work-shape/catalyst-chat-ui/build-area";
import { UiRoot, uiLabelsDe } from "@work-shape/catalyst-ui";
import { TranslationProvider } from "./chat-ui-render-harness";
import { required } from "./support/assertions";

// The folder chooser in a page: a row's status belongs to its box for a screen reader, and a
// rule typed by hand is still there after the chooser has answered.

const LISTINGS = {
  "": {
    folder: { id: "0", name: "Alle Dateien", path: "/" },
    folders: [{ id: "10", name: "Projekte" }]
  },
  "10": {
    folder: { id: "10", name: "Projekte", path: "/Projekte" },
    folders: [
      { id: "11", name: "Archiv" },
      { id: "12", name: "Haus A" }
    ]
  }
};

const source: Pick<KnowledgeBaseSource, "useSourceFolders"> = {
  useSourceFolders: (_connection, parent) => ({
    status: "ready",
    data: parent === "10" ? LISTINGS["10"] : LISTINGS[""]
  })
};

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const row = (id: string) =>
  required(document.querySelector<HTMLElement>(`[data-knowledge-folder="${id}"]`));
const box = (id: string) => required(row(id).querySelector<HTMLElement>('[role="checkbox"]'));

it("ties a row's status to its box, and keeps a typed rule when it answers", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onChoose = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        TranslationProvider,
        { children: null, locale: "de" },
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsDe },
          createElement(KnowledgeSourceFolderPicker, {
            source,
            connection: "files",
            connectionTitle: "Ablage",
            chosen: ["10"],
            exclude: "Handarbeit/**",
            onClose: () => undefined,
            onChoose
          })
        )
      )
    );
  });
  await act(async () => {
    required(row("10").querySelector<HTMLElement>("[data-knowledge-folder-open]")).click();
  });
  expect(box("11").getAttribute("aria-describedby")).toBeNull();

  await act(async () => box("11").click());
  const described = required(box("11").getAttribute("aria-describedby"));
  expect(document.getElementById(described)?.textContent).toBe("ausgelassen");
  expect(box("12").getAttribute("aria-describedby")).toBeNull();

  await act(async () =>
    required(document.querySelector<HTMLElement>("[data-knowledge-folders-apply]")).click()
  );
  expect(onChoose).toHaveBeenCalledWith(["10"], "Handarbeit/**\nArchiv/**");
});
