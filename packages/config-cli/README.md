# Catalyst CLI

`catalyst` is the command line tool for a Workshape Catalyst instance. It synchronizes agents and skills between a folder and an instance, and has one command for every asset operation, for every kind the instance registers (`catalyst <kind> <verb>`, `catalyst context`, `catalyst kinds`).

```sh
npm install --global @work-shape/catalyst-cli
catalyst --help
```

`catalyst setup <claude-code|codex|other> --instance <url>` connects an AI tool on your computer: it logs in by a code you confirm in the browser and writes the Catalyst skill the package ships to `~/.claude/skills/catalyst/` or `~/.agents/skills/catalyst/`.

It needs Node 22 or later. The key is read from `CATALYST_API_KEY`, is sent only to the instance you name over HTTPS, and is never written into the working copy.

Run `catalyst doctor` to check the address, sign-in, versions and effective key rights. Its four lines contain no keys, tokens, identities or response contents and are safe to share. Pass `--instance <url>` to select an instance explicitly. Use the instance's HTTPS origin, without `/api` or a sign-in path.

The CLI must be the server's release. When they differ and you run a command in a terminal, a CLI installed with `npm install --global` installs the server's version of itself, says so in one line and runs the command again; a Catalyst skill that `catalyst setup` wrote and you did not change is updated with it. It does this once per command and never in CI (`CI` set), without a terminal, or with `CATALYST_NO_AUTO_UPDATE=1`. There, and when the install fails, commands print the exact update command, including prerelease versions, for example:

```powershell
npm install --global @work-shape/catalyst-cli@<server-version>
catalyst doctor
```

Replace `<server-version>` with the version in the diagnostic. Run each line separately; this also works in Windows PowerShell 5.1, which does not support `&&`. A project-local installation is never updated by the CLI: the diagnostic names the project's folder and its install command (npm, pnpm or yarn, exact version); run it there, then `npx catalyst doctor`. Updating the CLI preserves saved sign-ins. After a manual update, run `catalyst setup <tool> --instance <url>` again to refresh the installed skill.

MIT licence.
