---
section: Added
---

- **Connections:** an instance keeps one OAuth app per authorization server, entered once by
  someone who may write every Connection (`PUT /api/v1/connections/:name/oauth-app`, CLI
  `catalyst connection secret set <name> --app`, `--adopt` to take the Connection's own secret).
  A Connection with authorization code sign-in on that server and client id, and no secret of its
  own, signs in, refreshes and revokes with it; a Connection's own secret still wins. The write
  deletes own secrets that are exact copies of the app's and leaves every other. The catalogue
  install form asks for the client id and secret only while the instance has no app for that
  server; the secret is never answered.
