---
title: Chat Experience
description: Configure the user-facing chat without forking the UI.
---

The chat experience should be configurable through release config and typed extension points.

Customer-specific copy belongs in the client layer, not in platform UI packages.

## Branding

Configure:

- customer or project display name
- logo URLs
- accent, background, surface, text, muted text, and border colors
- light and dark logo behavior

The standalone and embedded surfaces should consume the same safe config view.

## Copy

Configure:

- agent display names
- welcome messages
- composer placeholder
- empty-state text
- suggested prompts
- supported locales

Keep workflow examples concrete and customer-specific. Do not put them in platform packages.

## Feature Availability

The interface shows a control only when the instance supports the workflow behind it.

- Uploads are shown when the instance has something that takes the file. That is the module `documents`, which needs the document processing capability (part of the paid capabilities and not in the open repository), or enabled execution workspaces, which keep an uploaded file as a source file of the conversation's workspace. An instance with neither shows no upload, and `features.attachments.enabled` of `GET /api/v1/instance/config` is `false`.
- Editing a sent message and exporting a conversation are not part of this release.
- A tool with the permission mode `approval_required` cannot be enabled in this release, see [Permission Policy](/extend/custom-tools/#permission-policy).

## Domain UI Output

Some workflows need structured output beside the conversation, such as a document analysis panel or a tool-result renderer.

Model these as typed product surfaces. Avoid arbitrary frontend plugin execution in v1.

Good examples:

- `DocumentAnalysisViewModel`
- `ToolResultViewModel`
- `EscalationSummaryViewModel`

The tool returns structured output. The UI renders a known shape. The agent does not get to inject arbitrary UI code.
