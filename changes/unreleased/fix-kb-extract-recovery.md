---
section: Fixed
---

- **Knowledge Bases:** a PDF, DOCX, XLSX or PPTX whose extraction gave up while the store of files or the document worker was briefly down no longer stays `pending` for good, unsearchable and counted neither indexed nor failed. The extract job waited 30 and then 60 seconds between its three attempts, and a failure that ends in milliseconds took a whole queued backlog through every attempt within about two minutes; where the store of files was down, the job could not record the failure either. It now makes five attempts over about a quarter of an hour (1, 2, 4 and 8 minutes apart). A new job, `knowledge_base.recover_extracts`, runs every five minutes and at worker start and queues again every dead extract job whose content is still `pending` with a live document, at most 100 a run. Contents left `pending` by such a job before this release recover by themselves after the upgrade.
