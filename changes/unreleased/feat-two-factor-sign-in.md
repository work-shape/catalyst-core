---
section: Added
---

- **Sign-in:** Two-factor sign-in for accounts with e-mail and password: a code from an authenticator app after the password, with ten single-use backup codes. "Trust this browser for 30 days" at the code step skips the code in that browser for 30 days from when the code was entered; a sign-in there does not extend it. Codes by e-mail or SMS are not offered.
- **Settings > You > Security:** A person turns two-factor sign-in on (password, QR code drawn in the browser, first code, backup codes once), turns it off with the password, makes new backup codes, and stops trusting every browser.
- **Instance > Users:** "Reset two-factor sign-in" on a user deletes their second factor and trusted browsers and ends their sessions, so their next sign-in with the password leads to the setup. `POST /api/v1/instance/users/:userId/two-factor/reset` (`users.two_factor.reset`) needs `users.manage` under the same target rule as a password reset and is refused on one's own account.
- **Release config:** `auth.standalone.twoFactor.required` (default `false`) requires two-factor sign-in of every account with a password, existing sessions included: until a person has set it up, every operation but `me.get` answers 403 `FORBIDDEN` with `details.reason: "two_factor_setup_required"`, and the interface shows only the setup screen. A personal API key of such an owner is refused the same way; service principals are not affected.
- **Audit:** `user.two_factor_enabled`, `user.two_factor_disabled`, `user.two_factor_reset`, `user.two_factor_backup_codes_regenerated`, `user.two_factor_backup_code_used` (with the number left) and `user.two_factor_locked`. None holds a secret, a key address or a code.
- **API:** `me.get` and `me.update` carry `twoFactor { required, enrolled }` for a person signed in with a password; `users.list` carries `twoFactorEnabled` for each user with a password sign-in.
