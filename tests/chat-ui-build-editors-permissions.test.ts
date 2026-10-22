// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { BuildAsset } from "@work-shape/catalyst-chat-ui/build-area";
import { listedKind, mountBuildPage, unmountBuildPages } from "./chat-ui-build-page-harness";
import { settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

afterEach(unmountBuildPages);

const asset: BuildAsset = {
  id: "asset_model_reader",
  kind: "agent",
  name: "model_reader",
  scope: { kind: "instance" },
  revision: 1,
  allowed: ["write"],
  updatedAt: "2026-10-01T08:00:00Z",
  config: {
    name: "model_reader",
    displayName: "Model reader",
    instructions: "Help.",
    modelBindingId: "primary",
    toolNames: [],
    skillNames: [],
    initialPrompts: []
  }
};

it.each([true, false])(
  "passes the reader's model-management permission to the actual agent editor (%s)",
  async (canManageModels) => {
    const container = await mountBuildPage(
      asset,
      "agents",
      (request, url) => {
        if (url.pathname === apiOperations["platform.references.get"].path)
          return Response.json({
            modelProviderIds: ["local"],
            modelBindingIds: ["primary"],
            modelBindings: [{ id: "primary", model: "gpt-primary" }],
            fastModeModelBindingIds: [],
            reasoningEfforts: [],
            enabledToolNames: []
          });
        if (
          url.pathname ===
          apiOperations["agents.draft.get"].buildPath({ params: { name: asset.name } })
        )
          return Response.json({ draft: null });
        if (listedKind(request, url) !== undefined) return Response.json({ items: [] });
        return undefined;
      },
      ["displayName", "modelBindingId"],
      {
        user: settingsUser({
          roles: canManageModels ? ["superadmin"] : ["admin"],
          permissions: canManageModels
            ? ["config_assets.read", "config_assets.write", "agent_models.manage"]
            : ["config_assets.read", "config_assets.write"]
        })
      }
    );
    await vi.waitFor(
      async () => {
        await act(async () => {
          const model = required(
            container.querySelector<HTMLSelectElement>("section#model select")
          );
          expect(model.querySelector<HTMLOptionElement>('option[value="primary"]')?.selected).toBe(
            true
          );
          expect(model.disabled).toBe(!canManageModels);
        });
      },
      { timeout: CONDITION_WAIT_MS }
    );
  }
);
