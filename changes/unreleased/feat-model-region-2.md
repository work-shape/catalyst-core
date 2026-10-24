---
section: Changed
---

- **Connections:** `modules.connections.personalModelRegions` in release config lists the regions a model route may declare for a run to call a personal Connection. Unset, it is `[eu]` and nothing changes. A route without a region is still refused, and an empty list or an entry that is not a region stops startup with the field named. The `personal_connection_region` refusal now names the allowed regions and never a route. The operator widens the list only on the customer's written instruction, filed in the deployment repository; there is no switch in the interface and no new right.
