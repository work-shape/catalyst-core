import { createElement } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";
import { Chart, UiRoot, uiLabelsEn } from "@vivd-catalyst/ui";

const engine = vi.hoisted(() => ({ requests: 0, fails: true }));

vi.mock("@vivd-catalyst/ui/chart-engine", () => {
  engine.requests += 1;
  if (engine.fails) {
    throw new Error("The chunk could not be loaded.");
  }
  return { drawChart: vi.fn(), renderChartSvg: vi.fn() };
});

/** Renders the chart and waits for its engine request to settle, as a browser does. */
async function render(): Promise<string> {
  const { prelude } = await prerenderToNodeStream(
    createElement(
      UiRoot,
      { mode: "light", labels: uiLabelsEn },
      createElement(Chart, {
        type: "bar",
        rows: [{ month: "Jan", chat: 420 }],
        x: "month",
        series: [{ field: "chat", label: "Chat" }],
        locale: "en-US",
        ariaLabel: "Runs per month",
        emptyLabel: "No runs in this period."
      })
    )
  );
  let markup = "";
  for await (const chunk of prelude) {
    markup += String(chunk);
  }
  return markup;
}

describe("Chart when its engine cannot be loaded", () => {
  it("shows the empty box with the data table, and the next chart asks again", async () => {
    const failed = await render();

    expect(engine.requests).toBe(1);
    expect(failed).toContain(">No runs in this period.</div>");
    expect(failed).toContain('<th scope="row">Jan</th><td>420</td>');

    // The failure is not kept: a chart that mounts later sends a new request.
    expect(await render()).toContain(">No runs in this period.</div>");
    expect(engine.requests).toBe(2);

    engine.fails = false;
    const loaded = await render();
    expect(engine.requests).toBe(3);
    expect(loaded).not.toContain("No runs in this period.");
    expect(loaded).toContain('<div class="size-full"></div>');

    // A loaded engine is kept: no further request.
    await render();
    expect(engine.requests).toBe(3);
  });
});
