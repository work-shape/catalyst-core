---
section: Fixed
---

- **Shipped skills:** an instance skill under a shipped skill's name that no person ever wrote,
  only a service principal such as a config release or System, is now adopted at start: the seed
  writes the shipped skill over it, logs the adopted names, and agents keep listing it by name.
  Before, such a copy was kept forever with a warning, and could neither be updated (the name is
  reserved) nor deleted (an agent listed it). A copy a person edited is still kept with the warning.
