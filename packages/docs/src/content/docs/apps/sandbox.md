---
title: App sandbox and storage
description: What an App's frame allows, such as forms and event handlers, the per-person localStorage shim and kit storage, the network an App reaches, and the fonts and libraries it can load.
---

Part of [Build an App](/apps/build/).

## Sandbox, forms and personal state

Apps run with `allow-scripts allow-forms allow-downloads`, without `allow-same-origin`.
A form's validation and `submit` event work. Handle `submit` with `event.preventDefault()`
and call a named action; `form-action 'none'` blocks navigation to every form target.
Inline `onclick` and `onsubmit` attributes are refused: use `addEventListener` or React handlers.

An App or unsaved preview gets a `window.localStorage`-compatible shim before its first script runs.
It reads only the current person's state in that App; it never exposes the platform's browser
storage. The state is stored on the instance, survives reloads and App revisions, and is erased
with the App or the person's account. Native `getItem`, `setItem`, `removeItem`, `clear`,
`key`, `length` and property access work. Writes are synchronous in memory and persisted
in batches about every 250 ms, with the last write to each key winning. A
`catalyst-storage-error` event reports a persistence failure. A builder's draft preview
shares the same per-person state with the published App, so trying a draft can change
that person's preferences in the published App.

There is no `sessionStorage` shim: accessing it throws `SecurityError` in the sandbox.
The `localStorage` shim is not a native `Storage` object: `localStorage instanceof Storage`
is false. On `pagehide` and when the document becomes hidden, it tries to flush the batch,
but this is best effort. A write is lost if the page closes before its batch is saved.
An immediate reload within the batching window can also lose the write; await kit
`storage.set` before navigating or reloading when the save must persist.

Prefer the JSON API of kit **1.6.0** and later, whose save waits for persistence and rejects on failure:

```ts
import { storage } from "@work-shape/catalyst-app-kit";
const filters = await storage.get("filters"); // null until set
await storage.set("filters", { status: "open" });
```

Personal state holds at most 64 KiB of UTF-8 JSON per App and person. Catch storage errors
and show a retry beside the action. An unsaved preview keeps temporary in-memory state only.
When running outside the App runtime, catch `SecurityError` from native storage and keep rendering.
Use a **Data Store** and named actions for shared business records such as leave requests;
personal storage is for preferences and a person's unfinished input, not shared records.

## Network

Network requests are restricted by `connect-src`: an unsaved preview or a draft has no
outside network, and a published App reaches only reviewed hosts declared in its manifest.
Where the release turns on [outside hosts in a draft](/configure/release-config/#outside-hosts-in-a-draft),
the builder can allow a declared host for their own preview with one click.
Use named actions for Connections and Data Stores, never fetch the instance API directly.
Bundle fonts and libraries or use the kit; public CDNs do not load. When diagnosing a failure,
check form handlers, storage availability and the declared network policy before blaming the data.

## Light and dark

An App takes the look of the interface around it. The build links the kit's stylesheet and theme script into every HTML file of an App on kit 1.2.0 or later, also a single HTML file opened as it is. The script asks the interface for its theme and mode and keeps the instance's colours as CSS variables on `<html>`. In dark mode `<html>` also carries the class `dark` and `color-scheme: dark`, so what the browser draws itself (a scrollbar, a date picker, an unstyled field) is dark too. When the person switches between light and dark, the App follows without a reload. A React App on `mountApp` gets the same.

A plain element without a rule of the App's own already has these colours. A rule of the App's own sets colours from the variables, not from fixed values, or the App stays light in a dark interface:

| Variable                                            | For                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `--background`, `--foreground`                      | The page and its text                                                      |
| `--card`, `--card-foreground`                       | A raised surface, such as a card or a panel, and its text                  |
| `--muted`, `--muted-foreground`                     | A quiet surface, and quiet text such as a hint                             |
| `--primary`, `--primary-foreground`                 | The accent: the main button and its text                                   |
| `--border`, `--input`, `--ring`                     | Lines, a field's border, the focus ring                                    |
| `--destructive`, `--success`, `--warning`, `--info` | A state; each has `-foreground`, `-soft`, `-soft-foreground` and `-border` |

```css
.panel {
  background: var(--card);
  color: var(--card-foreground);
  border: 1px solid var(--border);
}
.hint {
  color: var(--muted-foreground);
}
```

Use fixed colours only where the person asks for a look of their own, such as a brand's. Such an App also sets `:root { color-scheme: light; }` (or `dark`), so that what the browser draws matches it whatever the interface's mode.

Plain HTML gets room around the body, the interface's font and type sizes, and styles for headings, text, links, lists, code, tables, buttons and form fields: write plain elements and set no page margin, font or colour unless the App needs a look of its own. The platform's stylesheet for plain HTML defines no class, so the App's class names are its own. A rule of the App's own wins when it stands outside any `@layer` or in a layer the App names itself; do not write it into `@layer base` or `@layer components`. An App that sets a background sets the text colour with it.

Which stylesheet an HTML file gets is decided per file by what its scripts import. A file with a script that imports `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@work-shape/catalyst-app-kit/ui`, `@work-shape/catalyst-app-kit/router` or `@tanstack/react-router` gets the kit's component stylesheet and none of the styles for plain elements, so build such an App with React unless it must be HTML. Every other HTML file gets the styles for plain elements, also one whose script imports `@work-shape/catalyst-app-kit` for actions or the context, or `drawChart` from `@work-shape/catalyst-app-kit/charts`.

## Fonts and libraries

Put fonts and libraries in the App's folder or use the kit's; an outside address (Google Fonts, Adobe Fonts or a CDN) will not load.

Kit 1.6.0 and later supply Inter (400, 600, 700), Lora (400, 700 and 400 italic), IBM Plex Mono (400, 600) and Bungee (400), with Latin coverage including German: link `/app-runtime/kit/1.8.0/fonts/fonts.css` and use the family name in CSS. The font sources and licences are in `/app-runtime/kit/1.8.0/fonts/README.md`.

A React App imports its CSS from a route (for example, `import "../fonts.css"`); in that CSS, write `@import url("/app-runtime/kit/1.8.0/fonts/fonts.css");` and `body { font-family: Lora; }`.
