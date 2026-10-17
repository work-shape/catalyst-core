---
section: Added
---

- **Studio:** The New connection dialog signs an MCP server in with OAuth where its test answers that it needs a sign-in: the step names the provider's host and the permissions it asks for, says that everyone who may use the connection acts through that account, opens the provider in a tab of its own and goes on to the tools once the Connection is signed in. A provider that registers no client asks for the client ID and secret it issued, with the redirect URI to copy. A declined, expired or refused sign-in says why at the step.
- **Studio:** The page a sign-in lands on (`/build/connections?signIn=…`) says whether it worked, takes the outcome out of the address, tells the tab that waits and closes itself after a sign-in.
- **Studio:** The Connection page has a section "Anmeldung" for a Connection that signs in with OAuth: state, provider, account, who signed in and since when, the permissions granted, for a client the provider issued its ID and the redirect URI, and Anmelden or Neu anmelden. Its recorded state says "Anmeldung nötig" where nobody is signed in.
- **Studio:** An agent's Tools mark the tools of a Connection nobody is signed in to with "Anmeldung nötig".
- **Studio:** Editing the settings of an OAuth Connection keeps its OAuth settings and its sign-in scheme.
