---
title: Catalog operations and Connections
description: Call API catalog operations and manage Connections from the CLI.
---

## Catalog operations and Connections

`call` sends any operation in the CLI's API catalog through the same client and server checks. Input is a JSON object with the API client's `params`, `query` and `body` fields. Use `--from <file>` or `--from -` for stdin; without `--from`, it reads piped stdin or uses `{}` at a terminal. Output is JSON, with the exit codes above. A held call prints `status: pending_approval` and its run, and exits 3.

```sh
catalyst call assets.get --from request.json
printf '%s' '{"params":{"kind":"agent","name":"assistant"}}' | catalyst call assets.get
catalyst connection secret set reporting < /path/to/secret
catalyst connection test reporting
catalyst connection discover reporting
catalyst connection tools
catalyst connection connect reporting
catalyst connection disconnect reporting
```

`connection secret set <name>` reads stdin or asks at a terminal with echo disabled. The hidden prompt accepts one line; Enter submits it. Send multi-line secrets, such as PEM keys, through stdin (`catalyst connection secret set reporting < key.pem`). It accepts no secret argument, removes one final line ending from stdin, and prints only the secret state and version. It reads the current version before writing; a concurrent replacement is refused. A key without the required scope or right gets the same refusal as the API.

`connection connect <name>` signs a Connection that uses OAuth in to its shared account. It starts the sign-in, opens the provider's page in your default browser and prints its address on stderr; `--no-browser` only prints it. Complete the sign-in in a browser where you are signed in to the instance as the person whose personal API key the CLI uses. The CLI waits until the Connection is connected, then prints the binding's state as JSON, never a token. A Service Principal's key is refused: a person chooses the account a Connection signs in to. If the sign-in expires first, the command exits 1; run it again. `connection disconnect <name>` ends the sign-in and revokes it at the provider.

For multipart operations, the JSON input's `file` names a local upload path. Binary responses print JSON with `contentType` and `base64`; streaming operations print one JSON event per line.
