---
title: Log in and API keys
description: Connect the CLI with a personal API key and manage the saved key.
---

## Log in

On an instance with the module `personalApiKeys` on, a person logs the tool in with a key of their own:

```sh
catalyst login --instance https://chat.example.com
```

The tool prints an address and a code such as `BCDF-GHJK`. Open the address, signed in as yourself; it leads to **Settings > You > API keys** (German: **Einstellungen › Du › API-Schlüssel**). Check that the code is the one your terminal shows, choose what the key may do and until when, and confirm. The tool then collects the key and saves it. Nothing is pasted anywhere: the code you confirm cannot be used to sign in, and the key travels only from the instance to the tool. A code expires after 15 minutes and is collected once.

A key acts as you, narrowed to its scopes. A scope is a right such as `agent.write`, on the whole instance or narrowed to one workspace, `agent.write:<workspace id>`, or to one asset that workspace owns, `agent.write:<workspace id>/<name>`. A key never does more than you may at the moment of each call: a right an administrator takes from you is gone from the key on its next call. A key lives at most a year. A new key starts with no scope ticked: tick the ones the key needs. **Settings > You > API keys** lists your keys and revokes them; a revoked key is refused on its next call. Whoever administers API access sees and revokes every person's keys. No key issues another key.

`catalyst logout --instance <address>` removes the saved key from this machine. It stays valid until you revoke it under **Settings > You > API keys**.

`catalyst setup <claude-code|codex|other> --instance <address>` logs in the same way where no working key is saved, then writes the Catalyst skill for an AI tool on your computer. [Connect a local agent](/getting-started/local-agent/) describes it.

A command without `--instance` works on the `defaultInstance` of the working copy's `catalyst.yaml`; one without a default is refused with the instances it names, and a saved key never chooses among them. Outside a working copy it works on the one instance a key is saved for, unless `CATALYST_API_KEY` is set. With none or several saved it names the saved ones and asks for `--instance`. `catalyst --version` prints the version of the tool.

## The key

The tool takes its key from the variable `CATALYST_API_KEY` when it is set, which is how automation runs it, and otherwise from the key `catalyst login` saved for the instance's address. It never takes a key as an argument and never writes one into the working copy.

- A saved key is kept in `~/.config/catalyst/credentials.json` (`$XDG_CONFIG_HOME/catalyst`, or `$CATALYST_CONFIG_HOME`), readable by you alone. A file others may read is refused until you `chmod 600` it.
- The key is sent only to the instance you name, and only over HTTPS. Plain HTTP is accepted for `localhost`, `127.0.0.0/8` and `::1`.
- The key is exchanged once for a short-lived access token. Every other request carries the token, not the key.
- An error message never repeats the key, and the tool never prints it.

`catalyst config local-key` was removed from this tool and exits with code 2. To create a key on a local development instance, run `pnpm config:local-key` in the client repository, as [Config assets](/configure/config-assets/#the-cli-working-copy) describes.
