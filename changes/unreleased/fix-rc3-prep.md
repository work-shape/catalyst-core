---
section: Fixed
---

- Let deployments supply React and React DOM through the chat UI and shared UI packages' peer dependencies, while retaining the tested runtime for core development. Release consumers verify both packages use the host runtime.
- Cover a deployment pin bump whose existing SheetJS lock entry loses its integrity during pnpm resolution; the deployment kit restores the verified hash before accepting the lockfile.
