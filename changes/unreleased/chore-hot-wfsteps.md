---
section: Changed
---

- **Workflows:** Each step type is one module in `packages/workflows/src/steps/<type>.ts` (its file form, what of it this engine does not run and what must hold of one step) with what the authoring skill says of it in `<type>.reference.ts`; the skill's sections live in `authoring-skill/sections/`. Behaviour-neutral: the same definitions are accepted and refused with the same issues in the same order, and the skill text is byte-identical.
