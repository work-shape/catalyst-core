---
title: Build an App
description: How an agent writes an App's folder and manifest, opens it in the preview and saves it as an App, and which page of the guide answers each further step.
---

This guide is what an agent follows. [Apps for people](/automate/apps/) says what a person clicks. Each page of it can be read on its own: read the one the task needs, not all of them.

| Task                                                                  | Page                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| Write the folder and `app.yaml`, open it, save it                     | This page                                                |
| Forms, personal storage, network, light and dark, fonts and libraries | [Sandbox and storage](/apps/sandbox/)                    |
| Live data: the kinds of action, drafts and publishing, `actions.call` | [Actions](/apps/actions/)                                |
| Read or change a connected system                                     | [Actions on a Connection](/apps/connection-actions/)     |
| Keep records in a Data Store                                          | [Actions on a Data Store](/apps/data-store-actions/)     |
| Start a Workflow                                                      | [Actions that start a Workflow](/apps/workflow-actions/) |
| A whole App to start from                                             | [App examples](/apps/examples/)                          |
| A save, a call or the preview fails                                   | [When an App fails](/apps/troubleshooting/)              |

## From folder to App

An agent writes an App's files in its execution workspace and shows the folder beside the conversation with `workspace.open`. Opening shows and does nothing more: it keeps nothing and creates no App. When the person asks to keep it, `app.save` makes it an App with a draft, and asks the person nothing: the App is in their Apps list at once and opens at its draft. A person publishes the draft; an agent never publishes.

A quick preview may show data the agent wrote into it. Live data comes through named actions: one file per action in the folder `actions/`, which the build compiles into the manifest. The browser calls an action by its name and nothing else: it never calls a Connection, a Data Store or a Workflow directly, and it never holds a key. See [Actions](/apps/actions/).

An App that shows what a Workflow made gets it as fields, not prose: the Workflow's `agent` step returns structured JSON through its `outputSchema`, and the App lays out each field itself. A large result can come without its output (`outputTruncated`); the App then says where the run's result is, never a generic error. See [Actions that start a Workflow](/apps/workflow-actions/#the-runs-output).

## Edit an existing App from any conversation

A person's **Edit in chat** on the App's page starts a new private conversation that already holds this checkout (`conversations.create` with `checkout: true`), so the agent changes `apps/<name>/` without calling `app.edit` first. Otherwise, call `app.edit` with the App's `name` (id) from discovery. It needs `app.write`, a private conversation in the App's workspace, and loads the current draft's complete source into `apps/<name>/`. It opens the saved preview and makes the App the conversation's subject. Read the loaded files, change that folder, call `workspace.open` on it and save with `app.save` on the same path. The original build conversation is not needed.

The folder is a working copy, without a lock. A save succeeds only while its base revision and commit are still the draft; its base moves atomically with a successful save. A refused save says who saved and when. Report that, call `app.edit` again to load the newer draft, redo your change on those files, then open and save again. Reload replaces the whole App folder, including unsaved files, and leaves other workspace files alone. Never force the old copy over a newer draft. Automatic merging and git history in the working folder are later slices.

## The folder

```text
<folder>/
  app.yaml                    the manifest
  index.html                  a plain HTML App: its entry
  src/routes/__root.tsx       a React App: TanStack Router file routes
  src/routes/index.tsx
  src/components/*.tsx        optional
  actions/<name>.action.yaml  a call of a Connection's operation, or the start of a Workflow
  actions/<name>.sql          a statement on the App's Data Store
  assets/                     images and other static files
```

Workspace commands have Python 3 and PyYAML (`import yaml`) in the runner image. Use
`yaml.safe_load` and `yaml.safe_dump` to read and update YAML; no package installation is needed.

Write the files with the workspace file tools, then open the folder that holds `app.yaml` with `workspace.open`. An open builds the folder and shows it. It answers the revision, or the build errors with file and line: fix the files and open it again. Before its next step the agent also reads what the preview did in the browser of the person whose turn it is: errors with file and line, failed calls by action and code, whether the kit's bridge connected and whether the page drew anything. When that person has no preview open, it reads "not viewed" and waits for nothing; the report follows once they open it. For a visual change the report cannot judge, such as layout, colours or a chart, the agent can look at the preview once with `preview.capture`: that person's browser takes the picture, and it shows small on the call in the run's work and opens larger on a click. A single HTML file opens as it is, and a folder without `app.yaml` opens its `index.html`. `app.save` with the same path and a name keeps what the preview shows as an App; each later `app.save` of the same path in the conversation writes the App's next draft revision, so keep working in the same folder and open it before each save.

A React App imports only its own files, `react`, `react-dom`, `@tanstack/react-router` and `@work-shape/catalyst-app-kit`. Nothing is installed. A plain HTML App names `entry: index.html`; inline scripts work, inline event handler attributes such as `onclick` do not. For fonts and libraries, see [Sandbox and storage](/apps/sandbox/#fonts-and-libraries).

## The manifest

`app.yaml` names everything the App reaches. A Connection or a Data Store that the manifest does not list cannot be called.

| Key                   | What it holds                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | Lowercase letters, digits and `-`, at most 63 characters.                                                                                |
| `name`                | The name people read.                                                                                                                    |
| `description`, `icon` | Optional.                                                                                                                                |
| `kit`                 | The exact kit version. Use `1.9.0` for a new App; actions on a Connection need `1.1.0` or later and `workflow` actions `1.3.0` or later. |
| `entry`               | `index.html` for a plain HTML App. A React App leaves it out.                                                                            |
| `connections`         | The Connections the App's actions call, by name.                                                                                         |
| `dataStores`          | The Data Store the App's `sql` actions use: `{ name, minSchema }`. One at most while the App has `sql` actions.                          |
| `actions`             | One line per `sql` action: `{ name, file, effect }`. Optional for the other kinds.                                                       |
| `externalHosts`       | Internet hosts the browser code may fetch from, such as `api.example.com`.                                                               |

Any other key is refused. `pages` is derived from `src/routes/` and is not written by hand.

## Preparing data scope

Follow the [build rules for data scope](/configure/release-config/#build-rules-for-data-scope).

- Read per-Mandant tables and group aggregates by the Mandant column.
- Keep Mandant data out of a free-SQL Knowledge Base.
- Say who an App is for when it serves only part of the firm. Everyone in that audience must be allowed to see every Mandant the shared source credential can read.
