---
section: Database
---

- Migration `0115_user_locale.sql` adds nullable `product_users.locale` for the existing language choice. Run migrations before API or worker startup. Existing accounts without a choice use the instance default. Rollback leaves the additive column in place; an older runtime ignores the stored choice.
