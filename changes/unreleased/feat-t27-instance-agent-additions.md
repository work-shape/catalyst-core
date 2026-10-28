---
section: Added
---

- **Shipped agents:** An agent that ships with the platform, such as Workshaper, has "Additions of this instance" ("Ergänzungen dieser Instanz", `additionalInstructions`): text the agent follows after its instructions, which a release never changes. The platform's instructions stay closed on the agent page until "Change platform text" opens them. Where the instance changed a field and a release changed it too, the field shows both versions with "Take new version" and "Keep mine"; the definition names such fields under `shippedNewer`, which only a release adds to. A pending draft of a shipped agent is moved onto each release, so publishing it no longer writes the previous release's text back.
