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

Expose controls only when the backend supports the workflow.

Examples:

- uploads should stay disabled until file acquisition, storage, retention, and audit behavior exist
- message editing should stay disabled until the backend defines how regenerated model calls are persisted and audited
- export should stay disabled until export permissions and retention semantics are clear
- approval-required tools should stay disabled until runtime resume is implemented end to end

## Domain UI Output

Some workflows need structured output beside the conversation, such as a document analysis panel or a tool-result renderer.

Model these as typed product surfaces. Avoid arbitrary frontend plugin execution in v1.

Good examples:

- `DocumentAnalysisViewModel`
- `ToolResultViewModel`
- `EscalationSummaryViewModel`

The tool returns structured output. The UI renders a known shape. The agent does not get to inject arbitrary UI code.
