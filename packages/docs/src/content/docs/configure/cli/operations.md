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

### Start from a catalogue entry

```sh
catalyst catalogue list
catalyst connection init reporting --from accounting --part tools
# Edit connections/reporting/connection.yaml: fill in settings and review operations.
catalyst connection put reporting --from connections/reporting/connection.yaml --if-revision new
catalyst connection secret set reporting
catalyst connection test reporting
```

`accounting` stands for an entry the instance offers. `catalogue list` shows its entries, whether each is offered, and its available parts; `--json` prints their definitions. `connection init` reads that list and writes `connections/<name>/connection.yaml` under the current directory, or under `--dir`. It chooses the only available part if `--part` is omitted; with two parts, choose explicitly. Unknown entries, entries the operator has not offered and parts whose Connector type is missing are refused.

Init writes a local file and keeps its `catalogue: { entry, part, version }` link. It applies the part's fixed settings and field defaults, lists required settings to fill in, and copies operations with `enabled: false` and `exposure: []`. Review and enable the operations you accept and set their exposures before `connection put`. It grants no right, writes no secret and never overwrites an existing file. The instance checks the definition and the caller's rights when it is put.

`connection connect <name>` signs a Connection that uses OAuth in to its shared account. It starts the sign-in, opens the provider's page in your default browser and prints its address on stderr; `--no-browser` only prints it. Complete the sign-in in a browser where you are signed in to the instance as the person whose personal API key the CLI uses. The CLI waits until the Connection is connected, then prints the binding's state as JSON, never a token. A Service Principal's key is refused: a person chooses the account a Connection signs in to. If the browser comes back without connecting it, because the sign-in was refused or completed in another person's browser, or the sign-in expires, the command says so and exits 1; run it again. `connection disconnect <name>` ends the sign-in and revokes it at the provider.

For multipart operations, the JSON input's `file` names a local upload path. Binary responses print JSON with `contentType` and `base64`; streaming operations print one JSON event per line.
