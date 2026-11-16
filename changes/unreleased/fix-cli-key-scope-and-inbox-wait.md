---
section: Fixed
---

- **Config CLI:** A refusal because the API key does not carry a right its owner holds
  (`outside_key_scope`) now says why and what to do: a key carries only the rights ticked when it
  was issued, so a right given after that is missing from it, and `catalyst login` confirms a new
  key with it (or a new key from Settings > API keys where `CATALYST_API_KEY` is set).
