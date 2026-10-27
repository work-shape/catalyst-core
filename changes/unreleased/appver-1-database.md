---
section: Database
---

- `0158_config_asset_publications`: the table `config_asset_publications`, one row per publish of an asset with a draft, numbered from 1 per asset. It backfills version 1 for every asset published now, credited with the time and the person of its newest retained successful publish event of that revision, or else the asset's last change and nobody. Expand only; a rollback leaves the table unread. The migration sets a lock timeout of 5 seconds and adds the foreign key after the backfill, so its scan of `audit_events` holds no lock on `config_assets`. A publish made by a worker of the previous release while it drains is not recorded: such an App's head says "Published" without a number until it is published again, which takes the next number.
