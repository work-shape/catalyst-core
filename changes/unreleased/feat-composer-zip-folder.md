---
section: Added
---

- **A .zip in a project chat's composer:** a `.zip` handed to the composer of a chat in a project is unpacked into a folder of the project, named after the archive, and the archive itself is not kept or attached; the message waits until the folder is in. Chats without a project still attach the `.zip` as one file. The file caps are checked against the real size of each entry while the archive is unpacked, here and on the project page, so an archive that declares small sizes is stopped at the cap with a plain sentence and nothing is sent. An archive with an entry that climbs out of its folder with `..` is refused.
