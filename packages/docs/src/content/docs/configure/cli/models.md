---
title: Model providers
description: Add a model provider to the release config and check it on a running instance.
---

## What it does

The `models` commands set up the model providers of an instance you operate. `add` writes a provider into the release config of a deployment repository; `check` asks a running instance whether the provider answers with its key; `list` shows what the release config holds. [Use your own model provider](/operate/own-model-provider/) walks through each provider from start to a checked instance.

```sh
catalyst models add azure --endpoint https://<resource>.openai.azure.com --model <deployment>
catalyst models add vertex --project <project-id> --model gemini-3.1-flash-lite
catalyst models add bedrock --model <profile-arn> --label "Claude Sonnet 4.6"
catalyst models add openai-compatible --id <id> --base-url <url> --model <model>
catalyst models check azure-eu --instance https://chat.example.com
catalyst models list --instance https://chat.example.com
```

## Add

`models add <azure|vertex|bedrock|openai-compatible>` writes three things into one release config file:

- the provider's entry under `infrastructure.models.<id>`, with `region: eu` and the name of its secret in `credentialSecret`;
- a model binding on it under `modelBindings`;
- its price row under `usage.costs.customer.models`, with the three prices per million tokens. Where the config has no rate card yet, it writes one with the instance's id, this month as its version and `--currency` (EUR).

At a terminal it asks for what its flags leave out; without one it names the missing flags and exits 2. The id is `azure-eu`, `vertex-eu` or `bedrock-eu` unless `--id` names another; an `openai-compatible` provider always needs `--id`. The binding takes the provider's id unless `--binding` names another.

It writes into `config/app.yaml`, or `config/app.base.yaml` where there is no `config/app.yaml`, or the file `--config` names. Lists in a config file replace the lists of the file it `extends`, so a binding or a price is written where the list already is: when the named file takes `modelBindings` or the rate card's models from a file it extends, the command refuses and names that file. After writing into a shared base, it names every environment file beside it that sets its own list, so the new binding or price does not reach that environment until it is added there too.

What was in the file stays as it was, comments and layout included: the command only adds lines after what is there. It reads the result back and writes nothing unless the result is the old file with the additions.

It refuses, and writes nothing:

- a region other than `eu`, with the reason. A provider outside the EU is a decision for whoever owns the release config, written there by hand;
- for Bedrock, a model that is no application inference profile of the account in `eu-central-1`, by the same rule the instance applies at startup, and a price of zero;
- an id or a binding the release config already has;
- a secret name that does not read as the name of an environment variable. The value is not repeated.

`add` never asks for a key, never reads one and never writes one. It prints the name of the one secret to set. The default name is the provider's own (`AZURE_OPENAI_API_KEY`, `GOOGLE_VERTEX_CREDENTIALS`, `AWS_BEARER_TOKEN_BEDROCK`); where another entry already uses it, the name is made from the id, such as `AZURE_SWEDEN_API_KEY`. `--secret <NAME>` names another.

`--fallback <binding>` writes `fallback` on the new binding: the chat binding that answers when its model is overloaded or cannot be reached. It refuses a binding the release config does not have, an embedding binding and one whose provider is not in `eu`. It writes one direction; the other binding's `fallback` is set by hand.

A Vertex binding states `agentSelectable: false`: the adapter carries no tool calls, which every agent run needs, so it serves the product's own calls, such as document extraction.

## Check

`models check <id>` runs `instance.infrastructure.check` on the instance and prints the provider's row: whether its secret is set, and `ok` or the class of the failure (`unreachable`, `timeout`, `access_denied`, `not_found`, `rejected`, `failed`) with the product's sentence for it. What a provider answered is never shown. The check runs where the key is, on the instance; the CLI never holds the key. It needs the right of the Infrastructure page (`system.view`). The instance runs the check at most once a minute; a call inside that minute waits for it. `--json` prints the row as JSON. The exit code is 0 for `ok` and 1 otherwise.

What `ok` shows depends on the provider: for Azure and other OpenAI-compatible endpoints, the key listed the endpoint's models; for Vertex, Google gave a token for the key; for Bedrock, Bedrock took the key. None of them calls the model. The first conversation with an agent on the binding does.

## List

`models list` prints each provider of the release config with its region, its secret's name, its bindings and whether every model it bills has a price. With `--instance`, it also reads `instance.infrastructure.get` and shows each provider's last check and whether its secret is set; a provider the instance does not have yet shows as not deployed. `--json` prints the same as JSON.
