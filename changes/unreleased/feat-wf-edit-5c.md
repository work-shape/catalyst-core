---
section: Changed
---

- **Workflows:** A start field (Settings tab) and an answer field of an AI step or a script are named by their title, such as "Monat", and no longer by their key (WF-EDIT-5c). A new field's key is made from its title as a new step's id is made from its name ("monat"; lowercase letters, digits and `_`), follows the title until the field is saved and then stays when the title changes, because later steps and the start form read the field by it. The key shows only as a small detail under the title. A new field opens without a word against its missing title: it is said once the field is left, or by the first Save, which saves nothing.
- **UI library:** `FieldListEditor` takes `titled` and `keyHint`: a person edits each field's `title`, and the key (`name`), which the caller derives, shows under it. `FieldListItem` gains `title`, and the labels `fieldTitle`, `fieldKey` and `field` (a field without a title yet is "Field 2").
- **Workflows:** On the canvas, the "Not saved", "Changed" or "New" tag of a step stands on a line of its own under the type, never beside the title, and a title wraps between its words only: at 73 % beside an open panel, "Belege prüfen" no longer breaks inside its words.
