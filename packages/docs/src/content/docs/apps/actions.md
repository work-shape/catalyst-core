---
title: App actions
description: The named actions that give an App live data, who may call them, what a reading and a changing action do in a preview, a draft and the published App, and how the App's code calls one with actions.call.
---

Part of [Build an App](/apps/build/). Each kind of action has its own page: [on a Connection](/apps/connection-actions/), [on a Data Store](/apps/data-store-actions/) and [starting a Workflow](/apps/workflow-actions/).

## Named actions

An action's name is the name of its file without the ending: `actions/load-bookings.action.yaml` is the action `load-bookings`. A name has lowercase letters, digits, `-` and `_`.

| Kind         | File                                                                  | Reaches                                          | Effect                       |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------- |
| `connection` | `actions/<name>.action.yaml` with `connection`, `operation`, `effect` | One operation of a Connection the manifest lists | Written in the file          |
| `sql`        | `actions/<name>.sql` plus a line under `actions` in `app.yaml`        | The Data Store the manifest lists                | Written in the manifest line |
| `workflow`   | `actions/<name>.action.yaml` with `workflow`                          | A run of the published Workflow                  | Always `changing`            |

Every call runs as the person who looks at the App, through the platform's policy and audit. In the published App the viewer needs the right to use the App; in its draft, the right to write it. Beside that, for a `connection` action the viewer needs the right to use the Connection. An `sql` or `workflow` action of a published App needs no right on the Data Store or the Workflow: the person who published the App needed it and answered for it. In the draft, whoever tries an action needs those rights of their own.

### The input of an action file

A `connection` or a `workflow` action file declares what the browser passes under `input`:

- `input.schema` declares the parameters: JSON Schema with `type: object`, `properties`, and optionally `required` and `additionalProperties: false`. A parameter is of type `string` (with `description`, `format` of `date` or `date-time`, `minLength`, `maxLength`, `enum`), `integer` or `number` (with `description`, `minimum`, `maximum`), `boolean` (with `description`) or `array` of one of them (with `description`, `items`, `maxItems`). Any other key, such as `pattern`, is refused by the build with the keys the parameter takes; check a pattern in the App's code. A parameter not declared is refused at the call.
- `input.mapping` is the input of what the action calls. A value `"{{name}}"` stands for the parameter `name`; every other value is passed as written. A mapping computes nothing: a text that holds `{{` other than as the whole value is refused by the build. A parameter the caller leaves out leaves out its key.

## Effects, drafts and publishing

A `reading` action runs live everywhere, with the viewer's rights. A `changing` action is carried out only in the published App; before that it runs in safe mode:

- In the draft of an App, a `changing` `connection` or `sql` action is simulated. It changes nothing and answers `{ status: "dry_run", message, result }`: `message` says what the call would have done, and whether live it would wait for another person's approval; `result` is the input it would have done it with. The call goes through the viewer's rights and the policy as a live call would, so a call that would be refused live is refused here too, and it leaves an Operation Run with the target `dry_run`. Show `message` as it is. A `workflow` action starts a test run of the Workflow instead: see [In the App's draft](/apps/workflow-actions/#in-the-apps-draft).
- "Run live once" on the App's Actions list, under "Technical details" on the draft page, carries out the next call of one changing `connection` or `sql` action of the draft for real. A person who may write the App switches it on for themselves; it covers only their own next call of that action, and every save or discard of the draft clears a switch nobody used, so an `app.save` clears it too. A call it sends live that the policy holds for another person's approval is refused with `approval_unavailable`, since a draft cannot wait. An agent cannot switch it on: when the person wants to try a change for real, tell them where the switch is.
- In a preview that is not yet an App, a changing `connection` or `sql` action is refused with the code `draft_safe_mode`, and nothing is called. A `workflow` action starts nothing and answers `{ status: "dry_run", message, result }` with what it would have started, and leaves no run.

A changing call passes `{ idempotencyKey }` in the draft as in the published App. The published App carries out every action. An action may ask for a stricter `policy` than the instance sets (`confirm`, `approval` or `deny`), written in the action file or, for an `sql` action, in its manifest line. A call that waits for another person's approval answers `status: "pending_approval"` without a result.

An agent never publishes. Tell the person to publish the draft: with the Publish button on the App's page, or with `catalyst app publish <name> --revision <n> --workspace <id>`. Publishing needs the right `app.publish`, which administrators hold. It checks again what a save checked, and that each Data Store is published, at `minSchema` or later, readable (for an insert, `data_store.insert`) by the person who publishes, and of the App's workspace; a retired store, or one of another workspace, is refused. Guardrails may answer the publish too.

Saving checks what it can: when a save writes the App's draft, it refuses a Connection that does not exist, a Data Store that does not exist, an operation the Connection does not accept and a `reading` action on a changing operation. `app.save` then answers `saved: false` with what was found: fix it, open the folder and save again. Whether the operation is enabled and offered to Apps (exposure `bridge`) is checked only at the call, which is refused as forbidden: check the operation's exposure on the Connection's page first.

## Calling an action from the App

Import `actions` from `@work-shape/catalyst-app-kit`. `actions.call(name, params, options)` calls a named action and answers `{ runId, status, result }`. `result` is what the action answered, as each kind's page describes: check its shape before using it. A call that is refused or fails rejects with an `AppCallError`. Show its `message` as it is, since it is the platform's sentence in the viewer's language, and offer no button to try again when `retryable` is false.

A changing call passes `{ idempotencyKey }`: make the key when the person acts, and send the same key again when the answer was lost. In a draft the answer to a changing `connection` or `sql` call is `{ status: "dry_run", message, result }` unless "Run live once" sent it live: show `message`, which says what the published App would have done.

An `AppCallError` with the code `not_connected` means the interface that shows the App never answered it: the App was shown outside the platform, or the page around it did not connect. It is a fault of the host, not of the App or its actions, and trying again inside the App does not help, so it is not retryable. Add no retries or reconnect buttons for it; reload the page or open the App again, and if it stays, say that the preview did not connect.

`getContext()` answers the viewer, the locale and, under `can`, what the instance says for each action: `allow`, `confirm`, `approval` or `deny`. The server asks again at every call.
