---
section: Added
---

- **A use level on personal API keys (CLI-PUBLISH-USE):** a personal key can carry
  `connection.use`, `data_store.insert`, `data_store.execute`, `knowledge_base.use` and
  `workflow.use`, with the same scope grammar as the other actions (`connection.use:kai-`). With
  them a person publishes from the CLI a Workflow whose Service Principal uses a resource: the
  no-escalation rule asks the person for each right the principal holds, within the key's
  scopes. A key without the level is refused with the missing right named, for example "The
  API key of this call does not cover 'connection.use' on the whole instance, and
  'workflow-runner' would act with it". The level never exceeds the owner's rights: a key is
  issued only with use rights the person holds somewhere, and a right taken from the person
  is gone from the key on its next call. The level adds no operation scope; it counts on the
  operations a key already reaches, so a key with `workflow.use` and a write scope also starts
  a Workflow its owner may start.
- **Settings > API keys** offers the level as **Use** / **Verwenden** beside the scopes, with
  the use rights the person holds (`useActions`, a new field of `platform.context.get`).
  `catalyst setup` opens the confirmation with `level=use`, which starts the key with the
  reading, writing and publishing rights the person holds and the level ticked (deleting is
  never ticked; `authoringActions`, a new field of `platform.context.get`); `catalyst login`
  and a code typed by hand start with nothing ticked.
- **Effect on an operated instance:** nothing changes for existing keys, which carry no use
  right. Rollback is a redeploy of the previous release; keys issued with the level then fail
  to parse those scopes and lose them, and are best revoked.
