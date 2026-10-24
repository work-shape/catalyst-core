---
section: Changed
---

- A capability brings asset kinds through its contribution (`assetKinds`, product-owned `CapabilityAssetKind` from core, re-exported by the capability SDK). The platform registers each beside its own and refuses a kind it already has. The guardrail kind now registers only through the built-in guardrails capability, while its module is on; nothing changes for an instance. `defineGuardrailAssetKind` is the kind as the capability brings it; `createGuardrailAssetKind` stays for a server assembled by hand.
