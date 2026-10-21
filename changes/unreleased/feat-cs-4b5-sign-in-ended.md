---
section: Added
---

- `catalyst connection connect` stops waiting once the browser came back without connecting the Connection, because the sign-in was refused or completed in another person's browser, and says so instead of waiting until the sign-in expires. `connections.oauth_start` answers the sign-in's `signInId`, and the new `connections.oauth_sign_in` (`GET /api/v1/connections/{name}/oauth/sign-ins/{signInId}`) answers whether a sign-in the caller started still waits for its callback.
