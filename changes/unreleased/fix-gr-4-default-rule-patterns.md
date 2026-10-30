---
section: Changed
---

- The default rules on chat input catch fewer ordinary documents. `chat-card-numbers` matches only numbers that start as a Visa, Mastercard, American Express or Discover card does, and warns instead of blocking, so phone numbers, tax numbers and the references of a bank statement pass and a document holding a card number can still be sent. `chat-passwords` no longer reads `Kennwort` or `pwd` and needs a digit or a symbol in the value, so "Passwort: kommt separat" passes.
- `chat-secrets` also blocks a token of 20 or more characters in an `Authorization: Bearer` or `Basic` header, an `x-api-key` header or an `api_key` setting, and a password in a URL such as `postgres://user:password@host`.
- `chat-special-categories` is off unless `chatInputGuardrails` switches it on with `true`, and matches statements such as a diagnosis, a sick note or a union membership, no longer Kirchensteuer, Konfession, Gewerkschaftsbeitrag or Behinderung, which stand on every payslip and self-disclosure.
