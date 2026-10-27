---
title: App bridge v1
description: The messages and calls between an App and the interface that shows it, frozen as version 1.
---

An App, and a Page of a conversation, runs in a sandboxed frame without an origin. It holds no credential and reaches nothing but the interface that shows it. The two talk through the bridge: messages posted between the frame and the interface. The App Kit (`@work-shape/catalyst-app-kit`) is the App's half; an App calls the kit and never posts a message itself.

## Version 1 is frozen

The bridge protocol is version 1. Every message of either side carries `catalystBridge: 1`, and the interface drops a message without it. What this page lists is the contract an App can build on:

- Version 1 is the set of messages and calls listed on this page. Further calls of the platform's bridge design, such as `files.open`, arrive additively within version 1.
- Changes to version 1 are additive only: a new message type, a new call of the kit, or a new optional field. An App written against version 1 keeps working.
- A new call needs a named App that cannot be built without it. It is added as a new member, never by renaming one.
- A breaking change, such as removing or renaming a message, a field or a call, or changing what one means, is version 2. Version 2 runs beside version 1, and the interface keeps answering version 1.
- A kit version is frozen too. An App names the exact kit version it was built with (`kit` in `app.yaml`) and keeps loading those files. A new Page or App names kit 1.8.0.

## Calls of the kit

| Call                                              | What it does                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getContext()`                                    | Greets the interface and answers the context below. It waits up to 10 seconds, then rejects: a Page runs inside the platform. A call made without that answer rejects with `not_connected`, which is not retryable: the fault is the host's, not the App's. |
| `onThemeChange(callback)`                         | Calls back with `{ theme, mode }` whenever the colours or the mode of the interface change. Answers the function that stops it.                                                                                                                             |
| `navigate(path)`                                  | Tells the interface the route the App shows.                                                                                                                                                                                                                |
| `resize(height)`                                  | Tells the interface the height of the App's content, in pixels.                                                                                                                                                                                             |
| `actions.call(name, input?, { idempotencyKey? })` | Kit 1.1.0 and later. Calls a named action of the manifest with the viewer's rights. Answers the result below, or rejects with an `AppCallError`.                                                                                                            |
| `workflowRuns.get(runId)`                         | Reads a Workflow Run that a `workflow` action of the App started, as the viewer who started it. Kit 1.3.0 and later.                                                                                                                                        |
| `useWorkflowRun(runId)`                           | A React hook that reads the run every second until it ended. Kit 1.3.0 and later.                                                                                                                                                                           |
| `storage.get(key)` / `storage.set(key, value)`    | Kit 1.6.0 and later. Small JSON state private to the current App and person (64 KiB). A save waits for persistence; shared records belong in a Data Store.                                                                                                  |
| `mountApp({ routeTree, element? })`               | Renders a React App with its routes and the look of the interface.                                                                                                                                                                                          |

An App reaches a Connection, a Data Store or a Workflow only through a named action in its folder: `actions/<name>.action.yaml` for an operation of a Connection or a Workflow, `actions/<name>.sql` for a statement on a Data Store. Each call goes through the policy, the audit and the viewer's rights.

## Messages the App sends

| `type`          | Fields                                                                                          | Answered with         |
| --------------- | ----------------------------------------------------------------------------------------------- | --------------------- |
| `ready`         | none                                                                                            | `context`             |
| `navigate`      | `session`, `path` (a route of the App: one leading `/`, no host, at most 2048 characters)       | nothing               |
| `resize`        | `session`, `height` (0 to 100000)                                                               | nothing               |
| `action`        | `session`, `requestId`, `name`, `input` (an object), optional `idempotencyKey`                  | `action_result`       |
| `storage_write` | `session`, `requestId`, `mutation` (`set` with string key/value, `remove` with key, or `clear`) | `storage_result`      |
| `workflow_run`  | `session`, `requestId`, `runId`                                                                 | `workflow_run_result` |
| `report`        | `report`: the platform's guard reports what the page did (`settled`, optional `empty`, at most 10 `entries`, `more`) | nothing |
| `capture_result` | `requestId`, and `image` (WebP bytes, at most 400 KB), `width` (at most 1280) and `height` (at most 1600), or `unavailable: true` | nothing |

`report` is sent by the platform's guard in the page frame, not by the kit, and needs no session. The interface and the instance each scrub and bound it, and the instance keeps it for the conversation's agent for 24 hours.

`capture_result` is the guard's answer to `capture`: a picture of the page as the person sees it, drawn in their browser, for an agent that asked to look at the preview. It needs no session. A browser that cannot draw the page into a picture, such as Safari, answers `unavailable: true`. The instance checks the picture's size again and keeps it with the conversation.

The runtime installs personal storage before App scripts run and supplies its session to storage writes. Every other message after `ready` names the session the interface gave in `context`. A message of another shape, with an unknown key, or naming another session is dropped.

### Retired: `connection_call`

Kits 1.1.0 to 1.3.0 have `connections.call(connection, operation, input)`, which sends `connection_call`; kit 1.0.0 had no call of a Connection, and kit 1.4.0 has none. The free call of a Connection from the browser was removed before version 1 was frozen. The interface answers it at once with an `action_result` whose error is `connection_call_removed`, not retryable, and whose message names the fix: an action file `actions/<name>.action.yaml` with `connection`, `operation` and `effect`, called with `actions.call('<name>', input)`. A call of it that waited for an approval when it was removed is ended when it is approved: it never reaches the Connection, and its run fails with the same message.

## Messages the interface sends

| `type`                | Fields                                                |
| --------------------- | ----------------------------------------------------- |
| `context`             | `session`, `context`                                  |
| `theme`               | `theme`, `mode`                                       |
| `action_result`       | `session`, `requestId`, `ok`, and `result` or `error` |
| `storage_result`      | `session`, `requestId`, `ok`                          |
| `workflow_run_result` | `session`, `requestId`, `ok`, and `run` or `error`    |
| `capture`             | `requestId`                                           |

`capture` asks the platform's guard, not the kit, for a picture of the page; the interface sends it only when an agent's run that serves the viewer asks to look at the preview.

The context holds `viewer` (`kind: member`, `id`, `displayName`), `workspace` (`id`, `name`, or `null`), `locale`, `theme` (seven colours: `surfaceColor`, `backgroundColor`, `textColor`, `mutedTextColor`, `borderColor`, `accentColor`, `accentStrongColor`), `mode` (`light` or `dark`), `pageId`, `fileSetNumber`, `initialRoute`, and `can`: for each action, what a call of the viewer would come to now (`allow`, `confirm`, `approval` or `deny`). `can` is a hint for what the App shows; each call is checked again.

The result of an action is one of:

- `{ runId, status: "done", result }`: the operation ran, and `result` is what it answered.
- `{ runId, status: "pending_approval" }`: the call waits for another person's approval. The run says how it ends.
- `{ status: "dry_run", message, result }` (kit 1.3.0 and later): a draft or a Page of a conversation carried nothing out. `message` is the platform's sentence of what the call would have done; show it as it is.

A run (`workflow_run_result`) holds `id`, `workflow`, `status` (`queued`, `running`, `waiting`, `done`, `failed`, `cancelled` or `limit_reached`), and where known `output` or `outputTruncated`, `error`, `startedAt` and `finishedAt`. `output` is the run's whole output up to 256 KiB as JSON; a larger output is answered as `outputTruncated: true` alone, and the App reads what it needs from where the Workflow wrote it. A test run that a `workflow` action of the App's draft started also holds `mode: "test"`, `workflowRevision` (`kind` `draft` or `published`, and `number` where known) and `simulatedSteps`, the ids of the steps whose calls were simulated; kit 1.8.0 and later pass them to the App.

An error holds `code` (such as `action_unknown`, `draft_safe_mode`, `forbidden`, `input_invalid`, `rate_limited` or `connection_call_removed`), `message`, and optionally `right` (the right a `forbidden` call lacks), `retryable` (`false` where the same call cannot come out differently) and `runId`. The kit rejects with an `AppCallError` that carries the same fields. A call nothing answers within 180 seconds rejects with `timeout`.
