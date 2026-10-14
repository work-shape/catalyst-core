---
section: Added
---

- **A guide to building an App:** the docs page `apps/build` shows an App's folder, its
  manifest and each kind of named action (`connection`, `sql`, `workflow`) with a complete
  example, what a Page and a draft do with a changing action, how the App's code calls an action
  through the kit and who publishes. The shipped skill `platform-docs` carries it, and a test
  builds every example on the page. `page.save` now describes `sql` actions, and `page.save`,
  `page.save_as_app` and the platform orientation point the agent at the page before it writes
  actions.
- **Build errors that name the fix:** a YAML file in `actions/` without the ending
  `.action.yaml` is refused with the name it needs (it was passed over, and the action was
  missing at the first call); an action file without `connection`, `operation` or `effect` says
  what the key holds; an unknown key on a line under `actions` in `app.yaml` says which keys a
  line holds and that an action file needs none.
