---
title: Apps for people
description: Ask an agent for an App, keep it as a draft, try its actions safely, run one live once, and publish it for your workspace.
---

An App is a small tool with its own screens, such as a form for new clients or a list of open offers. You get one by asking an agent in a chat. It can show data and, through its actions, read from or write to a connected system, a Data Store or a Workflow.

The German interface shows the labels in quotes. [Build an App](/apps/build/) is the technical guide the agent follows.

## Ask for it in a chat

Describe what you need: who uses it, what it shows, what it should let people do. For example: "Build an app where I can enter a new client and see the last ten."

The agent builds it and shows it beside the chat. **Preview** ("Vorschau") shows it working; **Files** ("Dateien") shows what it is made of. Keep asking for changes in the chat; each one the agent opens is the preview's newest revision.

The preview belongs to its conversation. It cannot change anything in other systems. To keep it, save it as an App.

When you have no App yet, the **Apps** page offers **Build an app in chat** ("App im Chat bauen"), which starts a chat for this.

## Keep it as an App

Tell the agent "keep this as an app". It saves the App under the name it was given and asks you nothing.

The App is yours at once: it is in your **Apps** list and opens at its **draft**, with live data. Builders of the workspace see the draft too; nobody else sees it until you share it by publishing.

You can also save it yourself:

1. In the preview's header, click **Save as app** ("Als App speichern").
2. Give it a **Name** and an **ID**. The ID is part of the App's address and cannot change later.
3. Click **Save** ("Speichern").

After that, each change you ask for in the same chat goes into the App's draft once the agent saves it again. When that did not happen, for example because someone changed the draft elsewhere, the preview offers **Update app** ("App aktualisieren"): **Replace draft** ("Entwurf ersetzen") puts what the preview shows now into the draft.

## Try it safely

Open **Apps** in the main rail and the App, then **Edit** ("Bearbeiten"). The draft opens on its **Preview**. **Technical details** ("Technische Details") beside it shows two more tabs, **Files** and **Actions** ("Aktionen"); your browser keeps them open until you fold them again.

In a draft, nothing changes for real:

- An action that only reads gets real data.
- An action that would change something is **simulated**. It answers with what it would have done and changes nothing. In the **Test** dialog the result says **Not carried out in the draft** ("Im Entwurf nicht ausgeführt").

On the **Actions** tab, **Test** ("Testen") calls one action with input you give.

## Run one action live once

To check that a changing action really works before you publish:

1. On the **Actions** tab, find the action and click **Run live once** ("Einmal live ausführen"). The button shows on actions that change something and are allowed to run without someone else's approval.
2. It now says **Your next call runs live.** ("Dein nächster Aufruf läuft live.")
3. Use the action once, in the preview or with **Test**. That one call is carried out for real, under the instance's usual rules. The next one is simulated again.

The switch is yours alone: it does not affect anyone else trying the draft. Saving or discarding the draft clears it. A call that would need someone else's approval is refused here, because a draft cannot wait for one.

## Publish it

1. On the draft, click **Publish** ("Veröffentlichen").
2. The dialog names the workspace that gets it, such as "Everyone in Sales gets revision 3 when they open the app.", and lists the Connections it uses and the outside hosts it calls.
3. Click **Publish** ("Veröffentlichen") in the dialog.

Now everyone in the workspace finds it on the **Apps** page, and up to five published Apps appear under **Apps** in the main rail. In a published App, every action runs for real, with the rights of the person using it. An action that starts a Workflow is the exception: the Workflow runs with its own account.

An agent never publishes. A person decides.

Later changes go to the draft again. The App shows **Unpublished changes** ("Unveröffentlichte Änderungen") until you publish them. **Discard** ("Verwerfen") throws the draft away, and **Revisions** ("Revisionen") under **More actions** ("Weitere Aktionen") shows every saved state.

## Who may do what

- Everyone in the workspace can open a published App.
- Saving an App, editing the draft, **Run live once** and publishing are rights of the administrator role. They cannot be given to one person. If you do not see **Save as app** or **Publish**, ask an administrator.
- An action reaches only what the person using the App may reach. The App's screens never hold a key: they call actions by name, and the instance makes the call.
