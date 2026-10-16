import { describe, expect, it } from "vitest";
import { htmlTitle } from "@work-shape/catalyst-app-build";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { saveAsAppInput } from "@work-shape/catalyst-chat-ui/apps";
import { pageSurface, readPageSave } from "@work-shape/catalyst-chat-ui/pages";
import {
  appIdFromName,
  asClientInstanceId,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { createAppSaveTool, type AppSaveInput } from "@work-shape/catalyst-tool-execution";

// OPEN-1f: saving asks for a name and nothing else, and the id is made from it. The agent's
// `app.save` and a person's Save as app make the same id of the same name, and the dialog
// proposes the name the folder gives itself. Fails without OPEN-1f: the dialog made its own id,
// which dropped the sound of German letters, and proposed the opened path.

/** An App that exists already, by the id its name gave it. */
const TAKEN = "umsatzuebersicht";

/** The id `app.save` asks the instance to create for `name`, read off the call it makes. */
async function idAppSaveSends(name: string): Promise<string> {
  const asked: AppSaveInput[] = [];
  const tool = createAppSaveTool({
    async saveApp(_context, input) {
      asked.push(input);
      return input.name === TAKEN
        ? { kind: "app", name: input.name, title: input.title, saved: false, message: "taken" }
        : {
            kind: "app",
            name: input.name,
            title: input.title,
            saved: true,
            created: true,
            revision: 1
          };
    },
    async appSaveBeforeEvents() {
      return [];
    },
    async appSavePolicyFloor() {
      return undefined;
    }
  });
  const parsed = tool.inputSchema.safeParse({ path: "revenue", name });
  if (!parsed.success) throw new Error(`app.save refused the name ${name}`);
  await tool.execute(parsed.data, context());
  const [call] = asked;
  if (!call) throw new Error("app.save asked the instance for nothing");
  return call.name;
}

function context(): ToolExecutionContext {
  const clientInstanceId = asClientInstanceId("app-save-name-client");
  return {
    clientInstanceId,
    correlationId: "corr_app_save_name",
    user: {
      id: "user-app-save-name",
      externalUserId: "user-app-save-name",
      displayLabel: "Builder",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}

describe("the id of a saved App", () => {
  it.each([
    ["Umsatzübersicht", TAKEN],
    ["  Größen & Maße 2026 ", "groessen-masse-2026"],
    ["Über_uns", "ueber-uns"],
    ["Café Crème", "cafe-creme"],
    ["???", "app"],
    ["a".repeat(40) + " " + "b".repeat(40), "a".repeat(40) + "-" + "b".repeat(22)]
  ])("is the same for app.save and Save as app of %j", async (name, id) => {
    const sent = await idAppSaveSends(name);

    expect(sent).toBe(id);
    expect(saveAsAppInput(name)?.id).toBe(sent);
    expect(appIdFromName(name)).toBe(sent);
  });

  it("names an App that exists for both, so the dialog's refusal is the agent's", async () => {
    // A second "Umsatzübersicht" asks for the id of the first: neither path invents another.
    expect(await idAppSaveSends("Umsatzübersicht")).toBe(TAKEN);
    expect(saveAsAppInput("Umsatzübersicht")).toEqual({ id: TAKEN, name: "Umsatzübersicht" });
  });
});

describe("the name a built preview is read by, which Save as app proposes", () => {
  const { t } = createTranslationContext("de");
  const built = (output: Record<string, unknown>) => ({
    output: { pageId: "page-1", fileSetId: "set-1", number: 3, ...output }
  });
  const proposed = (path: string | undefined, output: Record<string, unknown> = {}) => {
    const save = readPageSave({ args: path === undefined ? {} : { path }, result: built(output) });
    if (save.state !== "built") throw new Error("expected a built preview");
    return pageSurface("conv-1", save, t).title;
  };

  it("is the name the folder gives itself, then the folder's name, then Vorschau", () => {
    expect(proposed("apps/revenue", { title: "Umsatzübersicht" })).toBe("Umsatzübersicht");
    expect(proposed("apps/revenue")).toBe("revenue");
    expect(proposed("apps/revenue/")).toBe("revenue");
    expect(proposed("reports/q3.html")).toBe("q3");
    expect(proposed("apps/revenue", { title: "  " })).toBe("revenue");
    expect(proposed(undefined)).toBe("Vorschau");
  });

  it("reads the HTML title as a browser shows it, from the start of the file only", () => {
    const html = (text: string) => new TextEncoder().encode(text);

    expect(htmlTitle(html("<!doctype html><title>\n Wetter &amp; Wind </title>"))).toBe(
      "Wetter & Wind"
    );
    expect(htmlTitle(html("<html><head><TITLE>Angebote</TITLE></head></html>"))).toBe("Angebote");
    expect(htmlTitle(html("<!doctype html><h1>Hamburg</h1>"))).toBeUndefined();
    expect(htmlTitle(html("<title>   </title>"))).toBeUndefined();
    // A title in the body is no title of the document.
    expect(htmlTitle(html("<body><svg><title>Chart</title></svg></body>"))).toBeUndefined();
    // A file that is not HTML at all.
    expect(htmlTitle(new Uint8Array([0xff, 0xfe, 0x00, 0x3c]))).toBeUndefined();
    const late = `<!doctype html><!--${"x".repeat(70 * 1024)}--><title>Too late</title>`;
    expect(htmlTitle(html(late))).toBeUndefined();
  });
});
