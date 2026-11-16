---
section: Fixed
---

- **Config CLI:** A refusal because the API key does not carry a right its owner holds
  (`outside_key_scope`) now says why and what to do: a key carries only the rights ticked when it
  was issued, so a right given after that is missing from it, and `catalyst login` confirms a new
  key with it (or a new key from Settings > API keys where `CATALYST_API_KEY` is set).
- **Personal API keys:** Confirming a CLI's connect code no longer fails for each right the
  person does not hold. The key carries the scopes asked for that the person holds, and the
  answer of `me.connect_codes.confirm` names them (`scopes`) and those left out
  (`leftOutScopes`), which Settings shows after confirming. Only a code none of whose rights the
  person holds is refused, naming them all. A key created in Settings is still refused for a
  right its owner does not hold.
