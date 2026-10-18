---
section: Fixed
---

- **Knowledge Bases:** PDF conversion time now grows with the detected page count, bounded by the operator’s configured page limit. A conversion that still exceeds its deadline fails with `knowledge_conversion_timeout`; English and German document errors name the detected page count. Files above the configured page limit still fail before text conversion. No migration or new page ceiling.

- **Deployment:** Deploy the paired core change before the updated document worker. On rollback, roll back the worker first; retry stored conversion-timeout failures on a compatible core.
