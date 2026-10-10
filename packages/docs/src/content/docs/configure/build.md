---
title: Build agents and skills
description: Create, edit, restore and delete agents and skills in the Build area, on the whole instance or in the Namespaces you hold rights in.
---

**Build** is the area of the interface where agents and skills are made. It stands in the main rail as a row of its own and opens at `/build`. The old address `/admin/config` leads there.

Build works on the [asset API](/reference/api/assets/): it reads a list page by page, reads one asset when its page opens and writes one asset at a time. It never loads the whole set of agents and skills.

## Who sees Build

The Build row shows for a person who holds a right on at least one agent or skill:

- `config_assets.read` or `config_assets.write` on the instance, or
- a grant in a [Namespace](/operate/rights-and-namespaces/).

A person with a grant in a Namespace sees the assets of that Namespace and nothing else. A person with no such right has no Build row, and the address says that Build is not available.

A grant on one single asset is checked by the instance on every read and write, but the interface cannot see it in advance. Such a person has no Build row. The asset opens at its address, read-only.

## The list

Each kind has a list: **Agents** and **Skills**. A row shows the name, the Namespace if the asset is in one, the id and when it was last changed. A row is a link, so it opens in a new tab like any other link.

- **Search** asks the instance for names and ids that contain the text.
- **Namespace** narrows the list to one Namespace. It shows when you hold rights in more than one.
- **Show more** reads the next 50 rows.

The names in the list are in the instance's default language.

## Create

**New agent** or **New skill** opens a dialog for the name and the id. The id follows the name until you change it. It cannot be changed after the asset is saved.

If you hold the write right in a Namespace, the dialog offers that Namespace and the id starts with its prefix. Only Namespaces you may write in are offered. The choice **No Namespace** is offered to people who may write every asset of the instance.

**Continue** opens the page of the new asset. Nothing is stored until you press **Create agent** or **Create skill** there.

## Edit

An asset page has sections, and an index of them beside the content or above it on a narrow window. The save bar appears with the first change. It counts the changed fields and offers **Discard**.

Texts that exist in English and German are written in one language at a time. **Texts in** switches the language for the whole page. The switch marks a language in which texts are still empty. A field left empty in one language shows the text of the other one to people, and the field says so.

If you may read an asset but not change it, the page says so and has no save bar.

### When a save is refused

- **A tool, model or skill that is not allowed.** A Namespace can limit the tools and models of its agents. The refusal stands under the field it concerns, and the form keeps what you typed.
- **Somebody else saved first.** The page saves against the revision it loaded. If the asset changed in between, nothing is overwritten. A notice offers **Load the newer version**. Your text stays in the form until you choose it, so you can copy what you need first.
- **Anything else** is shown in the words of the instance, above the save bar.

## History and restore

**History** opens a panel beside the editor with every saved revision, the newest first. **Restore** makes the content of an older revision the newest one. The asset gets a new revision, so a restore can itself be restored.

## Delete

**Delete** is in the menu beside History, for people who hold the delete right on the asset. An asset that another one still refers to is not deleted, and the page says which reference stands in the way.

## Limits

| What                                                                 | Value     |
| -------------------------------------------------------------------- | --------- |
| Rows read per list request                                           | 50        |
| Wait after typing before a search                                    | 250 ms    |
| Skills offered per search in an agent's skill picker                 | 50        |
| How long the list of your Namespaces is kept before it is read again | 5 minutes |

The list never holds more than the pages you asked for. The Namespace filter and the create dialog list the Namespaces you hold rights in. History reads all revisions of the one asset when it opens.
