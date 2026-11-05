---
section: Changed
---

- **API keys:** A personal API key may be issued without an expiry. The New key form and the page that confirms a CLI's connect code offer "Never expires" ("Läuft nie ab") beside 30, 90 and 365 days; 90 days stays the default. Such a key acts until it is revoked, and a revocation still stops it on its next call. The key list shows "Never" ("Nie") as its expiry. `me.api_keys.create` and `me.connect_codes.confirm` take `expiresAt: null` for it; leaving the field out is still refused. A key without an expiry is answered and listed without `expiresAt`, and its audit events carry `expiresAt: null`. `catalyst login` and `catalyst setup` say such a key is valid "until it is revoked" and save it without an expiry.
