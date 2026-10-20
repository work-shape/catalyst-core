---
section: Changed
---

- **Tooling:** The Build frame's types are one file per part under `chat-ui/src/studio/build-area/build-kind/` (asset, editor props, create dialog, list lead, kind), still imported from `build-asset-kind`. An asset page's draft capabilities are one `draft` object (`state`, `canPublish`, `onRead`) in place of `draftState`, `canPublish` and `onDraftRead`, and the control-plane model takes the agent and dock callbacks as one `agentActions` object that it hands the Settings and Build pages as it is.
