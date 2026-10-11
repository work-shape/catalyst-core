import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadClientInstanceConfigFromFile,
  resolveModelBinding
} from "@vivd-catalyst/config-schema";
import { unbilledModelProviderIds } from "@vivd-catalyst/model-provider";

// The demo runs under a spend budget, and a call to a model without a price on the rate card
// is refused under one. Config validation asks a price only of the models agents start on, so
// a model a person picks in the composer can lack one: this file holds the demo's own offer.
describe("the demo's rate card", () => {
  it("has a price for the model of every binding the demo defines", async () => {
    const config = await loadClientInstanceConfigFromFile(resolve("clients/demo/config/app.yaml"));
    const priced = new Set(
      config.usage.costs.customer?.models.map((price) => `${price.providerId}/${price.model}`)
    );
    const free = new Set(
      unbilledModelProviderIds(
        config.modelBindings.map((binding) => resolveModelBinding(config, binding.id).provider)
      )
    );
    const offered = config.modelBindings.flatMap((binding) => {
      const { provider, model } = resolveModelBinding(config, binding.id);
      return free.has(provider.id) ? [] : [`${provider.id}/${model}`];
    });

    expect(
      config.usage.budget.dailySpendLimit ?? config.usage.budget.monthlySpendLimit
    ).toBeTruthy();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.filter((model) => !priced.has(model))).toEqual([]);
  });
});
