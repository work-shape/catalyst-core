---
title: Modules
description: Turn an optional feature on or off for a whole instance with one switch.
---

A module is one optional feature of the product together with everything it contributes: its operations, agent tools, job kinds and screens. Each module has one switch in release config, `modules.<name>.enabled`. The switch applies to the whole instance. It grants no rights: who may use an enabled feature is still decided by roles, permissions and workspace availability.

```yaml
modules:
  documents:
    enabled: true
  resources:
    enabled: true
  assetManagement:
    enabled: true
  userInvitations:
    enabled: false
```

## The Modules

| Module            | What it turns on                                                                                        | Needs                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `documents`       | Attached documents: preprocessing, the tools that read them and their page previews.                    | The document processing capability in the client assembly.                        |
| `resources`       | The Resources panel of a conversation.                                                                  | Nothing.                                                                          |
| `assetManagement` | Changing agents and skills in the interface. Running agents and `catalyst config push` work without it. | Nothing. `administration.agentConfiguration` still says what a person may change. |
| `userInvitations` | Inviting a user by an emailed link to set a password.                                                   | A mail sender under `infrastructure.mail` and standalone password sign-in.        |

The document processing capability is part of the paid capabilities and not in the open repository. The other three modules ship with the open platform.

A module that a later release adds is off until its entry says otherwise.

## What Off Means

A module that is off is off for every caller and on every surface:

- Each of its operations answers `404 NOT_FOUND` with `details.reason: "module_off"` and the module's name in `details.module`. The caller is authenticated first: a call without a valid credential gets `401` as on any route and learns nothing about modules. The module is checked before any right.
- Its agent tools are not offered to the model and cannot be called, also for an agent that still lists one. A write that adds or changes an agent that names such a tool is refused with a message that names the module. An agent stored before the module was turned off keeps its entry and runs without the tool: the instance starts, and a write to another agent or to a skill is not held up by it. The agent editor shows such an entry as not available, with the module, and lets it be removed.
- Its job kinds are not claimed. Jobs of such a kind that are already queued stay queued. **Settings > Instance > Jobs** shows each with the module it waits for, and `GET /api/v1/instance/jobs` names it in `waitingForModule`. They run when the module is on again.
- Its screens, panels and buttons are absent from the interface.

Turning a module off deletes nothing. Its stored data is there when the module is turned on again.

## Reading The Modules Of An Instance

**Settings > Instance > Modules** lists every module the product knows with its state, what it adds and its config key. The page is shown to holders of `audit.view` and changes nothing: the switch is release config. `GET /api/v1/instance/modules` returns the same list. A module whose code is not part of the build is listed as off with `shipped: false`.

## What Is Checked At Startup

The API and every worker resolve the same switches before they open the database or start a service. Startup stops with a message that names the module when:

- `modules` names a module the product does not know,
- a module is enabled but the build ships no code for it, for example `documents` without the document processing capability,
- a module is enabled and a module it requires is off. Nothing is turned on implicitly.

`GET /api/v1/instance/config` lists every module with its state under `modules`.

## Moving From The Old Switches

Before the `modules` section, the four modules were switched by other keys. For one release those keys keep working, and an instance whose config is not changed runs exactly what it ran before:

| Old key                                     | Without the old key the module was             | New key                           |
| ------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| `capabilities.documentProcessing.enabled`   | off                                            | `modules.documents.enabled`       |
| `ui.resources.enabled`                      | on                                             | `modules.resources.enabled`       |
| `administration.agentConfiguration.enabled` | off                                            | `modules.assetManagement.enabled` |
| none                                        | on wherever mail and password sign-in were set | `modules.userInvitations.enabled` |

When only the new key is set, it applies. When both are set to the same value, the config loads. When they are set to different values, the config is refused with a message that names both keys; remove the old one.

The release after this one removes the old keys. From then on a module without an entry under `modules` is off. Before that upgrade, write the four switches into `modules` with the state the instance runs today and delete the old keys. The `features` object of `GET /api/v1/instance/config` is derived from `modules` during the same release and leaves with the old keys.
