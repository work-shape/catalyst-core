---
title: Where data belongs
description: Which part of the platform holds which data (a skill folder, a Knowledge Base, a Data Store, a Connection or a file made in an App), and what to do instead of fetching with curl in a script.
---

Decide where data goes before you build. Each kind of data has one home, and the others cannot do its job.

| The data                                                                                 | Where it belongs                                         | Why                                                                                          |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Instructions, small fixed reference files, a calculator that needs nothing from outside | A [skill](#a-skill-folder) folder                        | It is read with the skill and the same for every run.                                        |
| A large or changing body of documents: statutes, manuals, a collection of files          | A [Knowledge Base](#a-large-or-changing-corpus)          | It is searched, not read whole, and it can be refreshed without a new skill revision.        |
| Records that people or Apps write: orders, entries, statuses                             | A [Data Store](#records-people-or-apps-write)            | It has tables and rights; a skill folder is read-only.                              |
| An outside system, or anything that needs a credential                                   | A [Connection](#an-outside-system-and-credentials)       | Only the platform holds the key, and it checks who may use it.                               |
| A PDF or other file an App makes                                                         | The [App's own code](#a-file-an-app-makes), in the browser | Nothing leaves the frame, and the download needs no server.                                |

## A skill folder

A skill holds the instructions an agent reads and what those instructions point to: a few fixed reference files, such as a checklist, a rate table or a template, and offline calculators in `scripts/`.

- A file is at most 2 MiB, a skill at most 8 MiB and 500 files. A save over a limit is refused with the path ([limits](/configure/config-assets/#a-skill-as-a-folder-of-files)).
- A script runs in the agent's workspace, as `python /skills/<name>/scripts/<file>.py`, in a sandbox with no network, no secrets and none of the platform's tools. It can read the skill's files and what is in the workspace, and write into the workspace. It cannot fetch anything.
- The libraries come from the runner image, not from the skill, and nothing can be installed. Python 3 has `numpy`, `pandas`, `openpyxl`, `pdfplumber`, `pypdf`, `python-docx`, `python-pptx`, `PyYAML`, `reportlab` and `Pillow`, with `pillow-heif`, `extract-msg`, `tnefparse` and `numbers-parser`. The image also has Node.js, `poppler-utils` (`pdftotext`, `pdfinfo`), LibreOffice, `7z`, `bsdtar` and `unzip`. The image of a release lists its Python packages in `/usr/local/share/catalyst/runner-packages.json`; read that file where the exact version matters.

Do not put a corpus into a skill. A skill is a revision: changing one statute means saving the folder again, and a folder near the limit holds a fraction of a real collection.

## A large or changing corpus

Statutes, manuals, contracts and any collection of documents go into a Knowledge Base ([Studio](/configure/build/#a-new-knowledge-base)). An agent that holds the Knowledge Base searches it and reads the passages that match, so the corpus can be far larger than a skill and the agent reads only what it needs. Fill it in one of three ways:

1. **Upload.** Add the files under **Documents** on its page, or call `knowledge.<id>.add_files`.
2. **A synced source.** A Connection to a document source that the build ships, such as Dropbox or Box, or a document management system, where the instance has one, syncs a folder into the Knowledge Base and keeps it current. A person adds the Connection and the key; see [Connect a system](/connect/connect-a-system/).
3. **A Workflow that adds documents.** For anything without a source of its own, a [Workflow](/automate/workflows/) lists the documents, for example through a Connection, and calls the Knowledge Base's `ingest` operation (`knowledge.<id>.ingest`). It needs `knowledge_base.ingest` for the Workflow's account. A scheduled Workflow keeps the corpus fresh. A pass that sets `complete: true` also withdraws the documents it no longer names.

When an agent answers from a Knowledge Base, it names the document and the date of the version it read, such as the date a statute was in force. A corpus that changes needs that date to be trusted.

## Records people or Apps write

Anything a person or an App creates and changes later, such as orders, bookings, case notes or settings per team, is rows in a Data Store. An App reads and inserts them with `sql` actions ([Actions on a Data Store](/apps/data-store-actions/)), an agent and a Workflow through the Data Store's operations. A Data Store has a schema made by migrations and rights per person. A skill folder is read-only in the workspace, and an App's personal storage holds 64 KiB per person: neither is a place for shared records.

## An outside system and credentials

Calling a system outside the platform, or anything that needs a key, a token or a password, goes through a Connection ([Connect a system](/connect/connect-a-system/)). A person creates the Connection and enters the key; nobody else sees it again. The Connection is then used:

- by an **agent**, which holds its tools;
- by a **Workflow**, as an operation step with its own account;
- by an **App**, only through a named [action on a Connection](/apps/connection-actions/). The App's code never holds the key and never calls the system itself.

Never use a skill script for this. It has no network and no secrets, and a key written into a skill is visible to everyone who can read the skill.

## What to do instead of `curl` in a script

A script that fetches a source fails twice: the sandbox has no network, and the result would be a file in a skill. Decide what the fetch is for.

- **Reference text that should be searchable** (statutes, a handbook): download the documents once, where you have the network, and upload them to a Knowledge Base. For a repeating fetch, make a Workflow that does it and calls `ingest`.
- **A call to an API with a key**: make a Connection, and give its tools to the agent or call it from a Workflow.
- **A calculation on data the person gives you**: keep the script in the skill, and have it read a file in the workspace. The agent puts the data there.
- **A small fixed table** that rarely changes and is well under 2 MiB: a reference file in the skill is fine.

If you cannot tell which applies, ask the person which of these the data is, rather than building the fetch into a script.

## A file an App makes

An App's frame allows downloads (`allow-downloads`), so an App makes a PDF, a spreadsheet or another file in the browser and offers it as a download. Bundle the library in the App's folder ([Fonts and libraries](/apps/sandbox/#fonts-and-libraries)), such as `pdf-lib` or `jsPDF` for a PDF; a CDN does not load. The data for the file comes through a named action. The platform does not provide a server-side PDF action for Apps.
