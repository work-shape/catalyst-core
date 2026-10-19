---
section: Added
---

- A field of a step's input that takes a string also takes text joined from parts (EW-TEXT): `{ text: ["Prüfergebnis ", { ref: { step: monat, path: label } }] }`, beside `{ value }` and `{ ref }`. A referenced part is a string, a number or a yes-or-no value, and `null` joins as empty text. A run label and a child's run key still take a literal or a reference only.
- Save and publish check each part like a reference: a part that names no step, a later step or an undeclared field is refused, and so is a part that references an object, a list outside a Markdown field or a dataset. A refusal (`text_part_invalid`) names the step, the field and the part.
- In a field whose schema has `format: markdown`, such as the body of `mail.send`, every referenced value is escaped as Markdown text, a referenced list of strings joins as a bulleted list and a list of flat records as a table in the order of its row schema, at most 100 rows and 8 columns. A longer list, a wider record, a record that is not flat and a dataset fail the step with `input_invalid`, as does a joined text longer than the field's `maxLength`. No message holds a value.
- The Workflow authoring skill describes the `text` form, and the step panel counts a part's reference among the step's sources.
