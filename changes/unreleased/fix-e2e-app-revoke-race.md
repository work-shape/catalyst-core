---
section: Fixed
---

- The browser test of a published App no longer fails at random: the second member's page closes before the test revokes their rights on the App, so the editor frame's late context request no longer meets the revoke and its 404.
