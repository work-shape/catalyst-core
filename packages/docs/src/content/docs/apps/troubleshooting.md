---
title: When an App fails
description: What the common build and save errors of an App mean and how to fix each, what the codes of a refused call mean, and what to check first when the preview shows nothing or a call fails.
---

Part of [Build an App](/apps/build/).

## When a save fails

The build answers each fault with its file and a sentence that names the fix. The common ones:

- `connection_not_declared`: the action calls a Connection that `connections` in `app.yaml` does not list.
- `data_store_not_declared`: an `sql` action and no `dataStores` in `app.yaml`.
- `key_reserved`: a reserved key, such as `rights`, `requires` or an action of `kind: code`; remove it.
- An `sql` file without its line under `actions`: add `{ name, file, effect }`.
- A YAML file in `actions/` without the ending `.action.yaml`: rename it.
- A missing `connection`, `operation` or `effect` in an action file: add it.
- `sql_statement_not_allowed`: a reading statement that is not one `SELECT` or `WITH`, or a changing one that is not one `INSERT` of parameters.

## When a call fails

A refused or failed call rejects with an `AppCallError` whose `code` says why. Show its `message` as it is.

| Code                   | What it means                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action_unknown`       | The manifest of the shown revision has no action of that name: open the folder and save it again after adding the file.                                                                                                     |
| `forbidden`            | The viewer lacks a right, named in `right`, or the operation is not offered to Apps (exposure `bridge`) on the Connection's page. Not retryable.                                                                            |
| `limit_reached`        | The action needed a model while a usage limit holds. The `message` says which limit and when it resets, and that an admin can raise it. Actions that need no model keep working. Not retryable until then.                  |
| `draft_safe_mode`      | A changing `connection` or `sql` action in a preview that is not yet an App. Save it as an App; its draft simulates the call.                                                                                               |
| `data_store_needs_app` | A reading `sql` action in a preview that is not yet an App. Save it as an App.                                                                                                                                              |
| `approval_unavailable` | "Run live once" sent a call that the policy holds for another person's approval; a draft cannot wait. Publish the App.                                                                                                      |
| `timeout`              | The interface took the call and did not answer in time. The same call may be sent again, with the same `idempotencyKey` for a changing one.                                                                                 |
| `not_connected`        | The interface that shows the App never answered it. A fault of the host, not of the App: retries inside the App do not help, and the code is not retryable. Reload the page or open the App again; add no reconnect button. |

## What to check first

When the preview shows nothing or a call fails, check the form handlers, storage availability and the declared network policy before blaming the data ([Sandbox and storage](/apps/sandbox/)). When an action answers but the App shows nothing, the answer's shape is not the one the code expects, as with JSON text in `content[0].text` of an MCP tool: call the operation once yourself and compare ([Actions on a Connection](/apps/connection-actions/#try-the-operations-first)).
