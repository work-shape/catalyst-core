import { describe, expect, it } from "vitest";
import type { DataToolSource } from "@vivd-catalyst/core";
import { agent } from "./support/access-instance";
import {
  asService,
  putAgent,
  putSkill,
  setupRelease,
  syncAsService
} from "./support/asset-release";

const validationRefs = {
  modelProviderIds: ["local"],
  modelBindingIds: ["plain", "other"],
  modelBindings: [],
  fastModeModelBindingIds: [],
  reasoningEfforts: [],
  enabledToolNames: ["known.tool", "second.tool"]
};

describe("agent tool references on the target instance", () => {
  it("resolves live data tools and refuses missing ones in validate and writes, even for an unchanged agent", async () => {
    let available = true;
    const toolName = "connection.crm.lookup";
    const dataTools: DataToolSource = {
      async describe(names) {
        return available && names.includes(toolName)
          ? [
              {
                name: toolName,
                description: "Look up a record",
                inputJsonSchema: { type: "object" },
                effect: "reading"
              }
            ]
          : [];
      }
    };
    const t = await setupRelease({ dataTools });
    const config = agent("rel-connected", {
      toolNames: [toolName],
      instructions: `Use \`${toolName}\`.`
    });
    const added = await syncAsService(t, [putAgent(config.name, config)]);
    expect(added.statusCode, added.body).toBe(200);
    available = false;
    const version = await t.version();
    const validation = await t.call(t.admin.id, "assets.validate", {
      params: { kind: "agent" },
      payload: { config }
    });
    expect(validation.statusCode, validation.body).toBe(200);
    expect(validation.json()).toMatchObject({ valid: false });
    expect(validation.body).toContain(`unavailable tool '${toolName}' in toolNames[0]`);
    expect(validation.body).toContain(`unavailable tool '${toolName}' in instructions line 1`);
    for (const operation of ["assets.sync_check", "assets.sync"] as const) {
      const refused = await asService(t, operation, {
        payload: {
          items: [
            putAgent(
              config.name,
              operation === "assets.sync"
                ? { ...config, instructions: `${config.instructions} Again.` }
                : config,
              1
            )
          ]
        }
      });
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.body).toContain(`unavailable tool '${toolName}'`);
    }
    expect(await t.version()).toBe(version);
    // SA-0: a stale stored agent does not block an unrelated write.
    const other = await syncAsService(t, [putSkill("rel-another", "Help.")]);
    expect(other.statusCode, other.body).toBe(200);
  });

  it("refuses an instruction reference whose tool module is off", async () => {
    const t = await setupRelease({
      server: (stores) => ({
        configAssets: {
          store: stores.configAssets,
          validationRefs: {
            ...validationRefs,
            offToolModule: (name) => (name === "known.tool" ? "example" : undefined)
          }
        }
      })
    });
    const checked = await asService(t, "assets.sync_check", {
      payload: {
        items: [putAgent("rel-disabled", { instructions: "Use `known.tool`." })]
      }
    });
    expect(checked.statusCode, checked.body).toBe(422);
    expect(checked.body).toContain(
      "Agent 'rel-disabled' references unavailable tool 'known.tool' in instructions line 1"
    );
    expect(await t.stored("agent", "rel-disabled")).toBeUndefined();
  });
});
