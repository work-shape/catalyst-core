---
section: Added
---

- A capability's asset kind can bring a preview of its draft (`AssetKindPreview`): a document of its own and the files it loads. The instance serves it in the frame of a Page, under the Page guard and the same Content-Security-Policy with `connect-src 'none'`. Of the revision's own files it serves only style sheets, images and fonts. `POST /api/v1/assets/{kind}/{name}/preview` (`assets.preview`) mints the frame address for a writer of the asset. The agent can create such a kind in chat. A save with `platform.assets.put` answers `preview: true`, and the interface shows a card and opens the draft beside the chat. The preview reports into the conversation about the asset, or the one that created it.
