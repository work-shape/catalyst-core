---
title: Use your own model provider
description: Run an instance on your own Azure OpenAI, Vertex AI or Bedrock account with one command, one secret and one deploy.
---

An instance calls models with your own endpoint and key: Azure OpenAI, Gemini on Vertex AI, Claude on Amazon Bedrock, or any endpoint that speaks the OpenAI API. Each takes four steps in the deployment repository: add the provider, set its secret, deploy, check.

1. `catalyst models add` writes the provider, a model binding and its price into the release config. It never asks for the key.
2. You set the one secret it names where the instance reads its secrets.
3. You deploy the release config.
4. `catalyst models check` asks the running instance whether the provider takes the key.

Whoever may change the deployment repository and deploy it may add a provider; the instance grants no right for it. The check needs an instance admin's key with `users.manage`. Every provider added this way processes data in the EU (`region: eu`); the command refuses another region. The [release config](/configure/release-config/#model-provider-configuration) describes every setting it writes, and [the command](/configure/cli/models/) every option.

Prices are per million tokens in the rate card's currency. Use what the provider bills you; the prices below are examples. Under a spend budget the instance refuses a model without a price, and Bedrock needs prices above zero always.

## Azure OpenAI

You need an Azure OpenAI resource in an EU region with a deployment of the model, its endpoint, such as `https://acme.openai.azure.com`, and one of its keys.

```sh
catalyst models add azure \
  --endpoint https://acme.openai.azure.com \
  --model acme-gpt-deployment --label "GPT-5.5" \
  --input-price 1.25 --cached-input-price 0.125 --output-price 10
```

`--model` is the name of the deployment. The entry calls the resource's v1 address with `authMode: api-key` and the Responses API (`--api chat_completions` for a deployment that only offers Chat Completions). Set the secret `AZURE_OPENAI_API_KEY` to the key, deploy, and check:

```sh
catalyst models check azure-eu --instance https://chat.example.com
```

`ok` means the key listed the resource's models. Agents can run on the binding `azure-eu`: choose it as an agent's model in its definition or in Studio.

## Gemini on Vertex AI

You need a Google Cloud project with the Vertex AI API on, and the JSON key of a service account with the role **Vertex AI User**.

```sh
catalyst models add vertex \
  --project acme-project --model gemini-3.1-flash-lite \
  --input-price 0.1 --cached-input-price 0.01 --output-price 0.4
```

The entry calls Google's EU endpoint. Set the secret `GOOGLE_VERTEX_CREDENTIALS` to the JSON key; with the `environment` secret provider, mount the file and set `GOOGLE_VERTEX_CREDENTIALS_FILE` to its path. Deploy, and check:

```sh
catalyst models check vertex-eu --instance https://chat.example.com
```

`ok` means Google gave a token for the key. It does not show that the account may call the model. The binding `vertex-eu` serves the product's own calls, such as the document extraction of the document processing capability (`capabilities.documentProcessing.extraction.modelBindingId: vertex-eu`); no agent runs on Gemini in this version, because the adapter carries no tool calls.

## Claude on Amazon Bedrock

You need an application inference profile of your AWS account in `eu-central-1`, built on an EU model or an EU inference profile, its ARN, and a Bedrock API key whose IAM policy allows `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on that profile alone. Set Bedrock's data retention to none and leave model invocation logging off.

```sh
catalyst models add bedrock \
  --model arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abcd1234efgh \
  --label "Claude Sonnet 4.6" \
  --input-price 2.8 --cached-input-price 0.28 --output-price 14
```

The account is the one the ARN names unless `--account` says otherwise; a profile of another account or region is refused before anything is written. Set the secret `AWS_BEARER_TOKEN_BEDROCK` to the key, deploy, and check:

```sh
catalyst models check bedrock-eu --instance https://chat.example.com
```

`ok` means Bedrock took the key. It does not show that the key may call the profile: that answers with `403` on the first call. Agents can run on the binding `bedrock-eu`.

## Another OpenAI-compatible endpoint

Any endpoint that speaks the OpenAI API and runs in an EU region:

```sh
catalyst models add openai-compatible --id acme-eu \
  --base-url https://llm.acme.example/v1 --model acme-model \
  --input-price 1 --cached-input-price 0.1 --output-price 4
```

`--api responses` for an endpoint that offers the Responses API, and `--auth api-key` for one that takes the key in an `api-key` header instead of a bearer token. The secret is named after the id, here `ACME_EU_API_KEY`.

## When something is not right

- **The check says the secret is missing.** The instance did not find the secret's name in its secrets: set it where the API and the agent run worker read theirs, and deploy again.
- **`access_denied`.** The provider refused the key. Set the right key, or a key of the right resource or account.
- **`not_found`.** The provider does not know the address or the project.
- **The instance does not start.** Startup names the field and the reason, never a key. Run `catalyst models list` to see what the release config holds.
- **An environment does not offer the binding.** An environment file that sets its own `modelBindings` replaces the shared list; `add` names such files. Add the binding there too.
