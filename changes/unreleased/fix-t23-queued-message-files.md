---
section: Fixed
---

- **Chat attachments:** A message sent with files while an answer runs now shows its files in the queue above the composer: a thumbnail for a picture, and the file names. Before, the files left the composer and only the text showed until the message started. Edit on a queued message returns its files to the composer with its text (`conversations.follow_ups.withdraw` takes `keepAttachments`); Remove still deletes them. Pending follow-ups carry `attachments`.
- **Chat attachments:** A file whose upload fails stays in the composer, marked as failed with the reason, and can be retried or removed. Sending waits until it is resolved. A file of a new conversation that the instance refuses no longer shows as ready.
- **Workspace source attachments:** Without a document-processing capability, PNG, JPG, GIF and WebP pictures are attached as images. They show in the chat history and reach a model that reads images. A picture is recognized by its bytes, and a file named as a picture whose bytes are not one is refused.
- **Local model:** The deterministic test model names each picture it received in its answer.
