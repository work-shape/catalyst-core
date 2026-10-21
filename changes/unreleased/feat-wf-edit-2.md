---
section: Added
---

- An AI step and a script have their Settings (WF-EDIT-2): an AI step's instructions, what a step gets (named values, each fixed or picked from an earlier result, which write the step's input schema from the kinds of the values), and what it answers with (a list of fields of text, numbers, whole numbers, yes or no, a choice, a list of texts, a group of fields or a list of groups, required or not, which writes its output schema; a group holds no group). A script is edited in place and saved as the step's file of the draft, so the next test run runs it. The language and the packages of a script stay read-only, and an answer the form cannot show stays with the agent.
- Switching a value to "From a step" in a step's Settings keeps it a pick until a field is chosen, and the save waits for it; before, the value turned fixed again.
