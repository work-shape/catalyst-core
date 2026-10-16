# App Kit fonts

Link `/app-runtime/kit/1.5.0/fonts/fonts.css`, then use `Inter`, `Lora`,
`IBM Plex Mono` or `Bungee` in `font-family`. All URLs in the stylesheet are relative.
These are unmodified Fontsource Latin-subset WOFF2 files, including German glyphs.
Only the listed faces ship; other scripts, weights and styles may be supplied by an App.

| Family        | Faces                       | Fontsource version | Upstream version | Licence                                | Source archive                                                                                            |
| ------------- | --------------------------- | ------------------ | ---------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Inter         | 400, 600, 700 normal        | 5.3.0              | v20              | [SIL OFL 1.1](./inter/LICENSE)         | [inter-5.3.0.tgz](https://registry.npmjs.org/@fontsource/inter/-/inter-5.3.0.tgz)                         |
| Lora          | 400, 700 normal; 400 italic | 5.3.0              | v37              | [SIL OFL 1.1](./lora/LICENSE)          | [lora-5.3.0.tgz](https://registry.npmjs.org/@fontsource/lora/-/lora-5.3.0.tgz)                            |
| IBM Plex Mono | 400, 600 normal             | 5.3.0              | v20              | [SIL OFL 1.1](./ibm-plex-mono/LICENSE) | [ibm-plex-mono-5.3.0.tgz](https://registry.npmjs.org/@fontsource/ibm-plex-mono/-/ibm-plex-mono-5.3.0.tgz) |
| Bungee        | 400 normal                  | 5.3.0              | v17              | [SIL OFL 1.1](./bungee/LICENSE)        | [bungee-5.3.0.tgz](https://registry.npmjs.org/@fontsource/bungee/-/bungee-5.3.0.tgz)                      |

Upstream source: [Google Fonts](https://github.com/google/fonts), distributed by
[Fontsource](https://github.com/fontsource/fontsource). Each family's original copyright
notice and full licence are beside its font files. The package and upstream versions above
are those recorded by Fontsource's `metadata.json` at acquisition (2026-10-16).

The committed files under `packages/app-kit/fonts/` are the release inputs. `kit:release`
stores their contents once by SHA-256 and records their versioned paths in a frozen manifest;
it does not fetch fonts at build or runtime. Nine font files total 182092 bytes.
