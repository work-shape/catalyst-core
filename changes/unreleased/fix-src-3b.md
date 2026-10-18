---
section: Fixed
---

- Source boundary changes hide documents with unknown ancestry until their boundary is verified, and immediately queue a full pass for upgraded items. A later sync replaces a pending withdrawal confirmation instead of joining the held pass. Ordinary running passes are still joined; approved or rejected confirmations keep their decision. No migration is required.
