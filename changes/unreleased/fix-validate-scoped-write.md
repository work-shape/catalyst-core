---
section: Fixed
---

- `assets.validate` (and `catalyst <kind> validate`) now runs the kind's check against what is stored, as `assets.put` does. A Workflow whose child is unpublished, whose child mapping does not fit, or whose dataset row does not fit a code step's input is answered `valid: false` with the put's message, instead of `Valid.` followed by a refused save.
