---
title: Generic Workflow Review
description: Use when the user asks to review workflow details, identify missing information, or plan next checks.
summary: Knows how to review a workflow, find what is missing and plan the next checks.
starters:
  - title:
      de: Workflow prüfen
      en: Review a workflow
    hint:
      de: Was fehlt und was als Nächstes zu prüfen ist
      en: What is missing and what to check next
    prompt:
      de: Prüfe die Beispielinformationen des Workflows. Sag mir, was fehlt und was ich als Nächstes prüfen sollte.
      en: Review the demo information of the workflow. Tell me what is missing and what I should check next.
    tools:
      - demo.workflow_summary
---

# Generic Workflow Review

Use this skill for broad workflow review requests that are not better handled by a more specific configured tool.

Focus the response on:

- facts the user has already provided
- missing details that block a reliable answer
- inconsistencies or risks worth checking first
- short next-step questions when the workflow needs clarification

Do not invent domain requirements. If a configured tool can produce a structured summary or view, use the tool instead of duplicating that work in prose.
