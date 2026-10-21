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

## Fonts and libraries

Put fonts and libraries in the App's folder or use the kit's; an outside address (Google Fonts, Adobe Fonts or a CDN) will not load.

Kit 1.6.0 and later supply Inter (400, 600, 700), Lora (400, 700 and 400 italic), IBM Plex Mono (400, 600) and Bungee (400), with Latin coverage including German: link `/app-runtime/kit/1.7.0/fonts/fonts.css` and use the family name in CSS. The font sources and licences are in `/app-runtime/kit/1.7.0/fonts/README.md`.

A React App imports its CSS from a route (for example, `import "../fonts.css"`); in that CSS, write `@import url("/app-runtime/kit/1.7.0/fonts/fonts.css");` and `body { font-family: Lora; }`.
