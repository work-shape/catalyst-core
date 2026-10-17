import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as library from "@work-shape/catalyst-ui";
import { galleryGroups, UiGallery, type GallerySectionId } from "@work-shape/catalyst-ui/gallery";
import { createThemeTokens, DEFAULT_THEME_INPUTS } from "@work-shape/catalyst-ui/theme";

const { Dialog, Drawer, HoverCard, HoverCardContent, HoverCardTrigger, IconButton, UiRoot } =
  library;
const { Tooltip, TooltipContent, TooltipTrigger, uiLabelsDe, uiLabelsEn } = library;
const { Avatar, Banner, Checkbox, Chip, ConfirmDialog, Field, Input, RadioGroup, Switch } = library;
const { DropdownMenu, DropdownMenuContent, Picker, PickerButton, Popover, PopoverContent } =
  library;
const { SkeletonList, scrollEdgeFadeStyle } = library;

describe("UiRoot", () => {
  it("carries the theme on its own element and holds the overlay container as its last child", () => {
    const markup = renderToStaticMarkup(
      createElement(
        UiRoot,
        { theme: DEFAULT_THEME_INPUTS.dark, mode: "dark", labels: uiLabelsEn },
        createElement("p", null, "content")
      )
    );
    const tokens = createThemeTokens(DEFAULT_THEME_INPUTS.dark, "dark");

    expect(markup).toMatch(/^<div class="dark" style="[^"]*--popover:color-mix\(/u);
    expect(markup).toContain(`--background:${tokens["--background"]}`);
    expect(markup).toMatch(
      /<p>content<\/p><div data-catalyst-overlays="" class="contents"><\/div><\/div>$/u
    );
  });

  it("sets no tokens without a theme, so the stylesheet's default shows", () => {
    const markup = renderToStaticMarkup(
      createElement(UiRoot, { as: "main", mode: "light", labels: uiLabelsEn })
    );

    expect(markup).toMatch(/^<main class="">/u);
    expect(markup).not.toContain("style=");
  });

  it("gives a dialog a container of its own, inside the dialog", () => {
    const markup = renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsDe },
        createElement(Dialog, {
          open: true,
          title: "Title",
          onClose: () => undefined,
          children: "Body"
        })
      )
    );
    const dialog = /<dialog[\s\S]*<\/dialog>/u.exec(markup)?.[0] ?? "";

    expect(dialog).toContain('data-catalyst-overlays=""');
    expect(dialog).toContain(`aria-label="${uiLabelsDe.close}"`);
    // The close button is no tooltip trigger: the dialog focuses it on opening.
    expect(/<button[^>]*aria-label="Schließen"[^>]*>/u.exec(dialog)?.[0]).not.toContain(
      "data-state"
    );
    expect(markup.split('data-catalyst-overlays=""')).toHaveLength(3);
  });

  it("stands a drawer on the same modal layer, against one edge of the window", () => {
    const render = (side?: "left" | "right") =>
      renderToStaticMarkup(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsDe },
          createElement(Drawer, {
            open: true,
            side,
            title: "Title",
            description: "What it is for",
            footer: "FOOTER",
            onClose: () => undefined,
            children: "Body"
          })
        )
      );
    const drawer = /<dialog[\s\S]*<\/dialog>/u.exec(render())?.[0] ?? "";
    const opening = /^<dialog[^>]*>/u.exec(drawer)?.[0] ?? "";

    // Named by its title and described by its description.
    const titleId = /<h2 id="([^"]+)"/u.exec(drawer)?.[1];
    const descriptionId = /<p id="([^"]+)"/u.exec(drawer)?.[1];
    expect(titleId).toBeDefined();
    expect(opening).toContain(`aria-labelledby="${titleId}"`);
    expect(opening).toContain(`aria-describedby="${descriptionId}"`);
    // The window's full height at the right edge, and the whole window where that is narrower.
    expect(opening).toMatch(/class="[^"]*\bh-dvh\b/u);
    expect(opening).toContain("w-[min(28rem,100vw)]");
    expect(opening).toMatch(/class="[^"]*\bml-auto\b/u);
    expect(opening).not.toMatch(/\bm-auto\b|\brounded-xl\b|max-h-\[/u);
    expect(/<dialog[^>]*>/u.exec(render("left"))?.[0]).toMatch(/class="[^"]*\bmr-auto\b/u);
    // Overlays opened inside it render into it, and the close button is no tooltip trigger.
    expect(drawer).toContain('data-catalyst-overlays=""');
    expect(/<button[^>]*aria-label="Schließen"[^>]*>/u.exec(drawer)?.[0]).not.toContain(
      "data-state"
    );
    expect(drawer).toContain("FOOTER");
  });

  it.each([
    [
      "Drawer",
      createElement(Drawer, {
        open: true,
        title: "Title",
        onClose: () => undefined,
        children: "Body"
      })
    ],
    [
      "Tooltip",
      createElement(Tooltip, {
        open: true,
        children: createElement(
          Fragment,
          null,
          createElement(TooltipTrigger, null, "t"),
          createElement(TooltipContent, null, "c")
        )
      })
    ],
    [
      "HoverCard",
      createElement(HoverCard, {
        open: true,
        children: createElement(
          Fragment,
          null,
          createElement(HoverCardTrigger, null, "t"),
          createElement(HoverCardContent, null, "c")
        )
      })
    ],
    [
      "Dialog",
      createElement(Dialog, {
        open: true,
        title: "Title",
        onClose: () => undefined,
        children: "Body"
      })
    ],
    ["IconButton", createElement(IconButton, { label: "Close" }, "x")],
    [
      "ConfirmDialog",
      createElement(ConfirmDialog, {
        open: true,
        title: "Title",
        confirmLabel: "Delete",
        onConfirm: () => undefined,
        onClose: () => undefined,
        children: "Body"
      })
    ],
    ["Popover", createElement(Popover, { open: true, children: createElement(PopoverContent) })],
    [
      "DropdownMenu",
      createElement(DropdownMenu, {
        open: true,
        children: createElement(DropdownMenuContent, { children: "c" })
      })
    ],
    [
      "Picker",
      createElement(Picker, {
        options: [],
        value: undefined,
        onValueChange: () => undefined,
        children: createElement("button")
      })
    ],
    ["Field", createElement(Field, { label: "Name", children: "c" })],
    ["Chip", createElement(Chip, null, "c")],
    ["Banner", createElement(Banner, null, "c")],
    ["Skeleton", createElement(SkeletonList)]
  ])("refuses to render %s outside a UiRoot and names it", (_name, element) => {
    expect(() => renderToStaticMarkup(element)).toThrow(/must be rendered inside UiRoot/u);
  });
});

describe("Button", () => {
  it("is a plain button unless the caller makes it a submit button", () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(library.Button, null, "Plain"),
        createElement(library.Button, { type: "submit" }, "Submit"),
        createElement(
          library.Button,
          { asChild: true },
          createElement("a", { href: "/next" }, "Link")
        )
      )
    );
    expect(html).toContain('type="button"');
    expect(html).toContain('type="submit"');
    expect(html.match(/type="/g)).toHaveLength(2);
  });
});

describe("form components", () => {
  const render = (element: ReturnType<typeof createElement>, labels = uiLabelsEn) =>
    renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels }, element));
  const attribute = (markup: string, tag: string, name: string) =>
    new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`, "u").exec(markup)?.[1];

  it("ties a field's label and hint to its control and marks it required", () => {
    const markup = render(
      createElement(Field, {
        label: "Name",
        hint: "Shown in the list",
        required: true,
        children: createElement(Input)
      }),
      uiLabelsDe
    );
    const hintId = attribute(markup, "p", "id");

    expect(attribute(markup, "input", "id")).toBe(attribute(markup, "label", "for"));
    expect(attribute(markup, "input", "aria-describedby")).toBe(hintId);
    expect(markup).toMatch(/<input[^>]*\srequired=""/u);
    expect(markup).not.toContain('aria-invalid="');
    expect(markup).toContain(`<span class="sr-only">${uiLabelsDe.required}</span>`);
    expect(markup).toContain(`<p id="${hintId}" class="text-caption text-muted-foreground">`);
  });

  it("names a proposed value's group by its label and keeps the value under it", () => {
    const markup = render(
      createElement(library.ProposedValue, { label: "Proposed by the agent" }, "Cite the clause.")
    );
    const labelId = attribute(markup, "span", "id");

    expect(attribute(markup, "div", "role")).toBe("group");
    expect(attribute(markup, "div", "aria-labelledby")).toBe(labelId);
    expect(markup).toMatch(/>Proposed by the agent<\/span><div[^>]*>Cite the clause\.<\/div>/u);
  });

  it("puts a section's state after its title", () => {
    const markup = render(
      createElement(
        library.Section,
        { title: "Instructions", state: createElement("span", null, "STATE") },
        "FIELDS"
      )
    );

    expect(markup).toMatch(/>Instructions<\/h2><span>STATE<\/span>/u);
  });

  it("puts a field's end slot on the label's row, outside the label", () => {
    const markup = render(
      createElement(Field, {
        label: "Instructions",
        labelEnd: "12 / 200",
        children: createElement(Input)
      })
    );
    const row =
      /<div class="[^"]*justify-between[^"]*">(<label[\s\S]*?<\/label>)(<div[\s\S]*?<\/div>)<\/div>/u.exec(
        markup
      );

    expect(row?.[1]).toContain("Instructions");
    expect(row?.[1]).not.toContain("12 / 200");
    expect(row?.[2]).toMatch(/^<div data-field-label-end=""[^>]*>12 \/ 200<\/div>$/u);
    // The control is still named by the label alone.
    const id = /<input[^>]*id="([^"]+)"/u.exec(markup)?.[1];
    expect(markup).toContain(`<label for="${id}"`);
    // Without the slot the label stands as before, with no row around it.
    const plain = render(createElement(Field, { label: "Name", children: createElement(Input) }));
    expect(plain).not.toContain("data-field-label-end");
    expect(plain).toMatch(/^(<div[^>]*>)+<label/u);
  });

  it("names a picker's button with its label and what is chosen, and takes the field's error", () => {
    const button = (value: string | undefined, error?: string) =>
      render(
        createElement(Field, {
          label: "Role",
          error,
          children: createElement(PickerButton, {
            label: "Role",
            placeholder: "Choose a role",
            value
          })
        })
      );

    expect(attribute(button(undefined), "button", "aria-label")).toBe("Role: Choose a role");
    expect(attribute(button("Member"), "button", "aria-label")).toBe("Role: Member");
    expect(button("Member")).toMatch(/<button[^>]*type="button"/u);
    expect(button("Member")).not.toContain('aria-invalid="');
    expect(button("Member", "Choose another role")).toMatch(/<button[^>]*aria-invalid="true"/u);
  });

  it("shows a field's error in the hint's place, announces it and marks the control invalid", () => {
    const markup = render(
      createElement(Field, {
        label: "Name",
        hint: "Shown in the list",
        error: "Too short",
        optional: true,
        children: createElement(Input)
      })
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Too short");
    expect(markup).not.toContain("Shown in the list");
    expect(markup).toMatch(/<input[^>]*aria-invalid="true"/u);
    expect(attribute(markup, "input", "aria-describedby")).toBe(attribute(markup, "p", "id"));
    expect(markup).toContain(`>${uiLabelsEn.optional}</span>`);
  });

  it("leaves a control outside a field as the caller wrote it", () => {
    const markup = render(createElement(Input, { id: "own", "aria-describedby": "note" }));

    expect(attribute(markup, "input", "id")).toBe("own");
    expect(attribute(markup, "input", "aria-describedby")).toBe("note");
    expect(markup).not.toMatch(/\s(?:required|aria-invalid)="/u);
  });

  it("gives a checkbox its three states and names it by its label", () => {
    const state = (checked: boolean | "indeterminate") =>
      attribute(
        render(createElement(Checkbox, { checked, label: "Select all", description: "3 rows" })),
        "button",
        "aria-checked"
      );
    const markup = render(createElement(Checkbox, { label: "Select all", description: "3 rows" }));

    expect([state(false), state(true), state("indeterminate")]).toEqual(["false", "true", "mixed"]);
    expect(attribute(markup, "button", "id")).toBe(attribute(markup, "label", "for"));
    expect(attribute(markup, "button", "aria-describedby")).toBe(attribute(markup, "p", "id"));
  });

  it("reads a switch that can be partly on as a tri-state check box, and a plain one as a switch", () => {
    const control = (props: { checked?: boolean; mixed?: boolean }) => {
      const markup = render(createElement(Switch, { "aria-label": "All tools", ...props }));
      return [attribute(markup, "button", "role"), attribute(markup, "button", "aria-checked")];
    };

    expect(control({ checked: true })).toEqual(["switch", "true"]);
    expect(control({ checked: false })).toEqual(["switch", "false"]);
    // Its role stays the same in every state, so a state change is not read as a new control.
    expect(control({ checked: true, mixed: false })).toEqual(["checkbox", "true"]);
    expect(control({ checked: false, mixed: false })).toEqual(["checkbox", "false"]);
    expect(control({ checked: true, mixed: true })).toEqual(["checkbox", "mixed"]);
  });

  it("renders a radio group with one radio per option and its hint as the description", () => {
    const markup = render(
      createElement(RadioGroup, {
        label: "Visibility",
        hint: "Changeable later",
        value: "private",
        options: [
          { value: "open", label: "Open", description: "Everyone" },
          { value: "private", label: "Private", disabled: true }
        ]
      })
    );

    expect(attribute(markup, "div", "role")).toBe("radiogroup");
    expect(markup.match(/role="radio"/gu)).toHaveLength(2);
    expect(markup).toMatch(/role="radio" aria-checked="false"[^>]*value="open"/u);
    expect(markup).toMatch(/role="radio" aria-checked="true"[^>]*value="private"/u);
    expect(markup).toMatch(
      /<button[^>]*value="private"[^>]*disabled=""|disabled=""[^>]*value="private"/u
    );
  });

  it("draws a person round and every thing as a rounded square, with initials from the name", () => {
    const avatar = (kind: "person" | "workspace" | "agent" | "app" | "workflow", name: string) =>
      render(createElement(Avatar, { kind, name }));

    expect(avatar("person", "Maria Schmidt")).toMatch(/rounded-full[^>]*>MS</u);
    for (const kind of ["workspace", "app", "workflow"] as const) {
      expect(avatar(kind, "marketing")).toMatch(/rounded-md[^>]*>MA</u);
    }
    expect(avatar("person", " ")).toContain(">?<");
  });

  it("draws every agent with the agent glyph, so it is the same mark wherever it is named", () => {
    const agent = (name: string) => render(createElement(Avatar, { kind: "agent", name }));

    expect(agent("Marketing")).toMatch(/rounded-md[^>]*><svg[^>]*lucide-bot/u);
    expect(agent("Research Assistant")).toBe(agent("Marketing"));
  });
});

describe("Picker", () => {
  it("shows only its button while closed and reports no search the reader did not type", () => {
    const searches: string[] = [];
    const markup = renderToStaticMarkup(
      createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(Picker, {
          search: true,
          onSearchChange: (search) => searches.push(search),
          options: [{ value: "alpha", label: "Alpha" }],
          value: undefined,
          onValueChange: () => undefined,
          children: createElement(PickerButton, {
            label: "Skill",
            placeholder: "Choose a skill",
            value: undefined
          })
        })
      )
    );

    expect(markup).toContain('aria-label="Skill: Choose a skill"');
    expect(markup).not.toContain("Alpha");
    // Typing, and the empty search a closing picker reports, need a browser.
    expect(searches).toEqual([]);
  });
});

describe("Badge", () => {
  const badge = (props: Partial<Parameters<typeof library.Badge>[0]>) =>
    renderToStaticMarkup(createElement(library.Badge, props, "Running"));

  it("shows a leading node in the dot's place, hidden from a screen reader", () => {
    const markup = badge({ leading: createElement("svg", { "data-icon": "" }), dot: true });

    expect(markup).toMatch(
      /^<span class="[^"]*"><span aria-hidden="true" data-slot="badge-leading"[^>]*><svg data-icon=""><\/svg><\/span>Running<\/span>$/u
    );
    // The dot would be a second mark for the same state.
    expect(markup).not.toContain("size-1.5");
  });

  it("keeps the dot, and no mark at all, without a leading node", () => {
    expect(badge({ dot: true })).toMatch(
      /^<span class="[^"]*"><span aria-hidden="true" class="size-1\.5 rounded-full bg-current"><\/span>Running<\/span>$/u
    );
    expect(badge({})).toMatch(/^<span class="[^"]*">Running<\/span>$/u);
  });
});

describe("Badge that truncates", () => {
  it("narrows to its row and keeps its whole text as its name and title", () => {
    const text = "Eine veröffentlichte Ausführung fragt hier nach Freigabe";
    const markup = renderToStaticMarkup(
      createElement(library.Badge, { tone: "warning", truncate: true }, text)
    );
    expect(markup).toContain(`title="${text}"`);
    expect(markup).toContain(`<span class="truncate">${text}</span>`);
    expect(markup).toMatch(/class="[^"]*\bmin-w-0\b[^"]*"/u);
    expect(markup).not.toMatch(/class="[^"]*\bshrink-0\b[^"]*"/u);
    // A badge that does not ask for it keeps its width.
    expect(renderToStaticMarkup(createElement(library.Badge, null, "Done"))).toMatch(/shrink-0/u);
  });
});

describe("Banner", () => {
  const inRoot = (banner: ReactNode) =>
    renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, banner));

  it("draws a line without a box: quiet text, and the tone on the icon alone", () => {
    const line = inRoot(
      createElement(
        Banner,
        { layout: "line", tone: "warning", icon: createElement("svg") },
        "Will be deleted soon."
      )
    );
    const banner = /<div role="status" data-tone="warning" class="([^"]*)"/u.exec(line)?.[1];
    expect(banner?.split(" ")).toEqual(
      expect.arrayContaining(["text-caption", "text-muted-foreground"])
    );
    expect(banner).not.toMatch(/border|bg-|rounded|text-warning/u);
    expect(line).toMatch(/<span class="[^"]*text-warning[^"]*"><svg>/u);
    expect(line).not.toContain("<button");
  });

  it("wraps its actions where one line is too narrow for them", () => {
    const button = (label: string) => createElement("button", { type: "button" }, label);
    const markup = inRoot(
      createElement(
        Banner,
        {
          title: "Entwurf, noch nicht veröffentlicht",
          action: createElement("span", null, button("Testlauf"), button("Veröffentlichen"))
        },
        "Body"
      )
    );
    const row = /<div class="([^"]*)"><span><button/u.exec(markup)?.[1];
    expect(row?.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-wrap", "min-w-0"]));
  });

  it("centres its actions on the whole message and keeps the icon on the title's line", () => {
    const markup = inRoot(
      createElement(
        Banner,
        {
          title: "Draft · not published",
          action: createElement("button", { type: "button" }, "Publish"),
          onDismiss: () => undefined
        },
        "Body"
      )
    );
    // The message and the actions share one row that centres them; the icon and the text share
    // one that starts at the top, so the icon stays beside the title.
    const row = /<div role="status"[^>]*><div class="([^"]*)"><div class="([^"]*)"><span/u.exec(
      markup
    );
    expect(row?.[1]?.split(" ")).toEqual(expect.arrayContaining(["flex", "items-center"]));
    expect(row?.[2]?.split(" ")).toEqual(expect.arrayContaining(["flex", "items-start"]));
    // An action is never pulled into the banner's padding.
    const actions = /<div class="([^"]*)"><button type="button">Publish/u.exec(markup)?.[1];
    expect(actions).toBeDefined();
    expect(actions).not.toMatch(/-my-/u);
    // The dismiss stays outside the row, so it never wraps under the actions.
    expect(markup).toMatch(/<\/div><\/div><button[^>]*aria-label="Dismiss"/u);
  });

  it("keeps the box and the tone's fill for the other layouts", () => {
    const inline = inRoot(createElement(Banner, { tone: "warning" }, "Read-only."));
    expect(inline).toMatch(/class="[^"]*border-warning-border bg-warning-soft[^"]*rounded-md/u);
    expect(inline).not.toContain("text-muted-foreground");
  });
});

describe("NotFound", () => {
  it("is an icon, one sentence as the page's heading, and one next step", () => {
    const markup = renderToStaticMarkup(
      createElement(library.NotFound, {
        action: createElement("button", { type: "button" }, "To chat"),
        children: "There is no page at this address."
      })
    );

    expect(markup).toMatch(/^<div data-not-found=""[^>]*><span[^>]*><svg[^>]*aria-hidden="true"/u);
    expect(markup).toContain(">There is no page at this address.</h1>");
    // The page's frame focuses the heading; like a page head's title, it shows no ring then.
    expect(markup).toMatch(/<h1 class="[^"]*\boutline-none\b[^"]*">/u);
    expect(markup.match(/<h1/gu)).toHaveLength(1);
    expect(markup.match(/<button/gu)).toHaveLength(1);
    expect(markup).toMatch(
      /<\/h1><div[^>]*><button type="button">To chat<\/button><\/div><\/div>$/u
    );
  });
});

describe("SurfaceFrame", () => {
  const render = (children: ReactNode) =>
    renderToStaticMarkup(createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, children));
  it("puts its slots in one order under a header of the shared height", () => {
    const slot = (text: string) => createElement("span", null, text);
    const markup = render(
      createElement(
        library.SurfaceFrame,
        {
          leading: slot("leading"),
          icon: slot("icon"),
          title: "name",
          subtitle: "subtitle",
          actions: slot("actions"),
          fullscreen: slot("fullscreen"),
          close: slot("close")
        },
        slot("content")
      )
    );
    const order = [
      "leading",
      "icon",
      "name",
      "subtitle",
      "actions",
      "fullscreen",
      "close",
      "content"
    ];
    const positions = order.map((text) => markup.indexOf(`>${text}<`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(markup).toContain("h-(--layout-header)");
    expect(markup).toMatch(/<h2[^>]*class="[^"]*text-heading[^"]*"[^>]*>name</u);
    expect(markup).toMatch(/<p class="[^"]*text-caption text-muted-foreground[^"]*">subtitle</u);
  });

  it("gives its content the inset and the scrolling unless the content is flush", () => {
    const body = (flush: boolean) =>
      /<\/header><div(?: data-flush="")? class="([^"]*)"/u
        .exec(render(createElement(library.SurfaceFrame, { title: "name", flush }, "c")))?.[1]
        ?.split(" ");

    expect(body(false)).toEqual(expect.arrayContaining(["p-4", "overflow-y-auto"]));
    expect(body(true)).toContain("overflow-hidden");
    expect(body(true)).not.toContain("p-4");
    expect(body(true)).not.toContain("overflow-y-auto");
  });

  it("takes product-owned props and no Radix type", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../packages/ui/src/structure/surface-frame.tsx", import.meta.url)),
      "utf8"
    );
    const imports = [...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);

    expect(imports.every((path) => path === "react" || path?.startsWith("../") === true)).toBe(
      true
    );
  });
});

describe("UI gallery", () => {
  // The root is what the gallery's panels are, and `ChartFieldError` is an error class, so
  // neither has an entry of its own.
  const withoutEntry = new Set(["UiRoot", "ChartFieldError"]);
  const exportedComponents = Object.entries(library)
    .filter(([name, value]) => /^[A-Z]/u.test(name) && isComponent(value))
    .map(([name]) => name)
    .filter((name) => !withoutEntry.has(name))
    .sort();
  const shown = galleryGroups.flatMap((group) =>
    group.entries.flatMap((entry) => entry.components)
  );

  it("has an entry for every component the library exports", () => {
    expect([...shown].sort()).toEqual(exportedComponents);
  });

  it("shows no component twice and names every entry once", () => {
    const names = galleryGroups.flatMap((group) => group.entries.map((entry) => entry.name));

    expect(shown.filter((name, index) => shown.indexOf(name) !== index)).toEqual([]);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it("has one group per library folder, in a fixed order", () => {
    expect(galleryGroups.map((group) => group.id)).toEqual([
      "foundations",
      "actions",
      "forms",
      "overlays",
      "navigation",
      "structure",
      "data",
      "flow",
      "status",
      "feedback"
    ]);
  });

  it.each(["de", "en"])("renders every entry in %s", (language) => {
    const render = (initialSection: GallerySectionId) =>
      renderToStaticMarkup(
        createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(UiGallery, {
            initialMode: "dark",
            initialLanguage: language,
            initialSection
          })
        )
      );

    for (const group of galleryGroups) {
      const markup = render(group.id);
      expect(markup).toContain(language === "de" ? "UI-Bibliothek" : "UI library");
      expect(markup).toContain('data-gallery-mode="dark"');
      for (const entry of group.entries) {
        expect(markup).toContain(`data-gallery-entry="${entry.name}"`);
      }
    }
    // The three sample pages show once each, under the one base theme.
    const samples = render("samples");
    for (const sample of ["build-list", "asset-page", "settings-form"]) {
      expect(samples).toContain(`data-gallery-sample="${sample}"`);
    }
    expect(samples.split('data-gallery-mode="dark"')).toHaveLength(4);
    expect(samples).not.toContain("data-gallery-theme");
  });
});

function isComponent(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

describe("scrollEdgeFadeStyle", () => {
  it("fades the edges that hide content, and only those", () => {
    const both = scrollEdgeFadeStyle({ above: true, below: true });
    const top = scrollEdgeFadeStyle({ above: true, below: false });
    const bottom = scrollEdgeFadeStyle({ above: false, below: true });

    expect(both?.maskImage).toBe(
      "linear-gradient(to bottom, transparent 0, black 1rem, black calc(100% - 1rem), transparent 100%)"
    );
    expect(top?.maskImage).toBe(
      "linear-gradient(to bottom, transparent 0, black 1rem, black 100%)"
    );
    expect(bottom?.maskImage).toBe(
      "linear-gradient(to bottom, black 0, black calc(100% - 1rem), transparent 100%)"
    );
    expect(both?.WebkitMaskImage).toBe(both?.maskImage);
    expect(scrollEdgeFadeStyle({ above: false, below: false })).toBeUndefined();
  });

  it("fades the left and right edge of a container that scrolls sideways", () => {
    expect(scrollEdgeFadeStyle({ above: false, below: true }, "x")?.maskImage).toBe(
      "linear-gradient(to right, black 0, black calc(100% - 1rem), transparent 100%)"
    );
    expect(scrollEdgeFadeStyle({ above: false, below: false }, "x")).toBeUndefined();
  });
});
