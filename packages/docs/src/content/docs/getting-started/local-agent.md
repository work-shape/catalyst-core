---
title: Connect a local agent
description: Connect Claude Code, Codex or another AI tool on your computer in one step, from Settings, Connect a local agent at /settings/you/connect.
---

A local agent is an AI tool on your own computer, such as Claude Code or Codex. Connected to the instance, it works through the `catalyst` command line tool as you: it reads and changes what you may read and change, and no more than the key you give it allows. It is not one of the instance's agents.

## Connect it

1. Open **Settings > Connect a local agent** (German: **Einstellungen > Lokalen Agenten verbinden**), at `/settings/you/connect`. The page is there when your instance offers personal API keys.
2. Pick your tool: **Claude Code**, **Codex** or **Other** (German: **Anderes**).
3. Copy the command and run it in a terminal on your computer. It needs Node 22 or later. It looks like this:

   ```sh
   npm install --global @work-shape/catalyst-cli@<version> && catalyst setup claude-code --instance https://chat.example.com
   ```

   The page fills in the instance's address and the version of the CLI published for it. Until one is published, the page says the command is not available yet and shows none.

4. Your browser opens **Settings > API keys** (German: **API-Schlüssel**) with a code. Check that it is the code your terminal shows, tick what the key may do and until when, and click **Confirm** (German: **Bestätigen**). The reading, writing and publishing rights you hold start ticked, so the key can pull, push and publish as offered, and so does the **Use** level (German: **Verwenden**); see below. Deleting is never ticked for you.
5. The terminal says which key it saved and where it wrote the skill. Start your tool.

The command installs the CLI, logs it in with a key of your own, and writes a skill that teaches your tool to use it: for Claude Code to `~/.claude/skills/catalyst/SKILL.md` (below `$CLAUDE_CONFIG_DIR` where that is set), for Codex and other tools to `~/.agents/skills/catalyst/SKILL.md`. For another tool, point it at that file. Nothing else of your tool's settings changes.

If a different file is already at that path, the command keeps it and says so. Run it again with `--force` to replace it; the old file is then kept as `SKILL.md.bak`, or as `SKILL.md.bak.1` and so on where that name is taken. The command never writes through a link at that path.

## Later

- Run the same command again to update the skill to a new release. A key that still works is kept.
- The key is listed under **Settings > API keys** with the name of the tool and your computer, such as "Claude Code on laptop". Revoke it there and the tool can no longer reach the instance.
- `catalyst logout --instance <address>` removes the key from your computer.

## What the tool may do

The key acts as you and never does more than you may do at the moment of each call. The scopes you tick narrow it further, for example reading agents only. A right an administrator takes from you is gone from the key at once.

The **Use** level lets the key use the Connections, Data Stores, Knowledge Bases and Workflows you may use: `connection.use`, `data_store.insert`, `data_store.execute`, `knowledge_base.use` and `workflow.use`. Settings offers the ones you hold. Your tool needs them to publish a Workflow whose Service Principal uses a resource, since publishing lends the Service Principal's rights and you may lend only what you hold. With them the tool can also start a Workflow you may start. For a key that only reads or writes, untick the level.

The skill tells the tool to pull before it pushes, to show you a change before it is sent, to never delete assets on the instance without asking you, and to treat a refusal as final.

## Keys stay with you

Nobody sends you a key, and no agent can make one. The page itself issues nothing: a key exists only after you confirm the code your own terminal shows. An agent in the chat that is asked for a key answers with the link to Connect a local agent. Never confirm a code somebody else sent you.

Run `catalyst docs` for this release's product docs index, or `catalyst docs <page>` for a page from it.
When `catalyst context` finds an older CLI than the published version the instance names, it prints an npm update command on stderr; it leaves stdout unchanged and never updates itself.
