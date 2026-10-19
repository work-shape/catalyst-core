import { describe, expect, it } from "vitest";
import { appPreviewSchema } from "@work-shape/catalyst-api-contract";
import type { ScopeAssignmentInput } from "@work-shape/catalyst-core";
import { setupAppInstance, appFiles, expectStatus } from "./support/app-instance";
import { clientInstanceId } from "./support/access-instance";

describe("an App viewer without a data assignment", () => {
  it("gets the missing-scope label, while assigned and all viewers do not", async () => {
    const t = await setupAppInstance({
      commits: false,
      server: (_stores, config) => ({
        config: { ...config, scopes: { mandant: { label: "Mandant", valueType: "text" } } }
      }),
      build: async ({ files }) => ({
        status: "built",
        kitVersion: "1.0.0",
        manifest: {
          id: "offers",
          name: "Offers",
          kit: "1.0.0",
          entry: "index.html",
          actions: [
            {
              kind: "sql",
              name: "rows",
              file: "actions/rows.sql",
              dataStore: "findings",
              effect: "reading",
              parameters: [],
              input: { schema: { type: "object", properties: {} } },
              statement:
                "select * from findings where $viewer.scope_all('mandant') or mandant_nr = any($viewer.scope('mandant'))"
            }
          ]
        },
        files: files.filter((file) => file.path !== "app.yaml")
      })
    });
    try {
      expectStatus(await t.putApp(t.admin.id, "offers", appFiles("scoped")), 200);
      const preview = async () => {
        const response = await t.call(t.admin.id, "apps.preview", {
          params: { app: "offers" },
          payload: { mode: "draft" }
        });
        expectStatus(response, 200);
        return appPreviewSchema.parse(response.json()).unassignedScopes;
      };
      expect(await preview()).toEqual(["Mandant"]);
      const assignments: ScopeAssignmentInput["values"][] = [["101"], "all"];
      for (const values of assignments) {
        await t.stores.access.setScopeAssignment({
          clientInstanceId,
          holderKind: "user",
          holderId: t.admin.id,
          dimension: "mandant",
          effect: "allow",
          values
        });
        expect(await preview()).toBeUndefined();
      }
    } finally {
      await t.close();
    }
  });
});
