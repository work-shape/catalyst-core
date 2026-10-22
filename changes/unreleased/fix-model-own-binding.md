---
section: Fixed
---

- An agent that names no model binding, and so runs on its provider's own model, no longer shows that model twice in the model picker: once under its raw deployment name and again as the binding for the same model. Where the agent lists a binding for the same provider and model, its own model is that binding, with the binding's label and vendor. A run without a pick then names that binding and runs on the same provider and model.
