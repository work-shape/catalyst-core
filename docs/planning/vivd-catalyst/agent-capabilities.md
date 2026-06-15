# Agent Capabilities

Agent capabilities should be explicit, permissioned tool groups. The platform should avoid giving agents broad internet or browser access by default, especially for sensitive document workflows.

## Capability Layers

Use layered capabilities instead of one broad "web access" tool:

1. **URL/file fetch**
   - Fetches a direct URL and stores the result as a managed file.
   - Best for signed links, direct PDF/image links, and static public documents.
   - V2 capability. V1 keeps only the file-acquisition concept/interface shape needed by document processing.

2. **HTML scrape/extract**
   - Fetches an HTML page and extracts links, text, metadata, and candidate downloadable files.
   - Useful when the email link points to a simple landing page rather than the file itself.

3. **Browser automation**
   - Runs a real browser through Playwright or an agent-browser framework.
   - Needed for JavaScript-heavy pages, multi-step flows, authenticated portals, or pages where a user would need to click through.
   - Should be a future capability, not the first path for v1 document retrieval.

4. **Provider URL context**
   - Some model providers can retrieve URL context directly.
   - Useful for summarizing public pages, but not enough as the system of record for document acquisition because the platform needs file storage, audit, retention, access control, and deterministic validation.

## URL/File Fetch Design

For email links to files, the first real implementation should be a deterministic file acquisition tool:

```yaml
tools:
  - file.fetch_url
  - read_document
```

`file.fetch_url` should:

- accept a URL and optional expected content type
- enforce domain allowlists or policy rules
- block private, loopback, link-local, and metadata-service addresses
- limit redirects
- enforce max file size
- enforce timeout
- validate MIME type and extension
- store downloaded bytes in managed file/object storage
- return a file id, detected MIME type, size, checksum, and source URL
- audit who/what requested the fetch and which redirects occurred

This is usually enough for signed document links. It is safer and more reliable than browser automation.

This is v2 because production URL fetching may need more deployment design than it first appears: egress IP reputation, domain allowlists, signed URL handling, customer network access, possible residential proxy requirements, malware scanning, and audit/retention policy.

## HTML Scrape/Extract Design

`web.extract_links` or `web.extract_document_links` can sit between fetch and browser use:

- fetch HTML with the same network safety rules as `file.fetch_url`
- parse links and forms
- score candidate document URLs
- return candidates for the agent or human to select
- optionally call `file.fetch_url` for high-confidence document links

This handles many "email link points to a page with the PDF" cases without a browser.

## Browser Automation Design

Browser automation should be modeled as its own execution runtime/capability, not as a normal in-process tool.

Recommended future shape:

```text
agent runtime
  -> browser task tool
  -> browser worker/container
  -> Playwright/browser-use/Gemini Computer Use
  -> downloaded files stored as managed files
```

Security requirements:

- isolated browser worker/container
- no access to internal network unless explicitly allowed
- no customer secrets unless scoped to the browser task
- allowlisted start URLs/domains
- max step count and wall-clock timeout
- download size limits
- audit trail with URLs visited, downloads, and screenshots when appropriate
- human confirmation before risky actions

Candidate implementation references:

- Playwright for deterministic browser automation: https://playwright.dev/docs/intro
- browser-use for open-source AI browser automation: https://github.com/browser-use/browser-use
- Gemini Computer Use for model-driven UI actions: https://ai.google.dev/gemini-api/docs/computer-use

Browser automation is powerful but overkill for v1 if the file links are direct or simple landing pages.

## Document Processing Tools

Document processing should be a pipeline, not one monolithic tool:

```text
file.fetch_url / upload
  -> file storage
  -> document preprocessing
  -> read_document
  -> document.extract_structured
  -> validation / human review
```

Suggested tools:

- `read_document`: reads prepared document text from a managed file whose upload-time preprocessing has completed.
- `document.extract_structured`: extracts schema-bound fields from a file or Markdown result.
- `document.compare_fields`: compares extracted facts with application/email statements.
- `document.redact`: removes or masks sensitive fields where needed.

## MarkItDown

Microsoft MarkItDown is a strong candidate conversion engine for upload-time document preprocessing.

Relevant current capabilities:

- Converts PDF, Word, Excel, PowerPoint, HTML, images, audio, text formats, ZIP, YouTube URLs, EPub, and more.
- Supports images with EXIF metadata and OCR.
- Has optional dependencies for Azure Document Intelligence and Azure Content Understanding.
- Supports plugins, including `markitdown-ocr`, which adds OCR to PDF/DOCX/PPTX/XLSX converters through LLM vision using the same `llm_client` / `llm_model` pattern as image descriptions.
- Runs as Python/CLI/Docker, so it should be called through a document-processing worker/container rather than embedded into the TypeScript core.

Sources:

- https://github.com/microsoft/markitdown
- https://microsoft-markitdown.mintlify.app/formats/overview
- https://github.com/microsoft/markitdown/blob/main/packages/markitdown-ocr/README.md

## Structured Document Extraction Provider

`document.extract_structured` should stay provider-agnostic. Gemini on Vertex AI should be considered, especially for PDFs, scanned documents, images, tables, and layouts, but provider choice must be gated by region, data residency, DPA/AVV, model availability, and customer approval.

For sensitive production workflows, prefer enterprise cloud endpoints such as Vertex AI in an approved EU region over consumer Gemini/API surfaces. Do not couple the document extraction interface to one provider.

Relevant current capabilities:

- Gemini document understanding can process PDFs using native vision, including text, images, diagrams, charts, and tables, and can extract information into structured outputs.
- Gemini image understanding supports image inputs and text output.
- Gemini structured outputs support schema-bound responses.
- Gemini OpenAI compatibility exists, which may make it usable with libraries expecting OpenAI-compatible clients, though direct Google GenAI SDK integration may be cleaner for production.
- The concrete model should be selected at implementation time from current stable models that support the required EU/approved region and data handling guarantees. Avoid preview models for production unless the reason is explicit.

Sources:

- https://ai.google.dev/gemini-api/docs/document-processing
- https://ai.google.dev/gemini-api/docs/image-understanding
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/openai
- https://ai.google.dev/gemini-api/docs/models
- https://cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency
- https://docs.cloud.google.com/vertex-ai/docs/general/locations

## Version Recommendation

V1 should include:

- upload-time document preprocessing for supported text-related documents
- `read_document` as the first agent-facing document reading tool
- MarkItDown evaluation as the default conversion backend behind preprocessing
- `document.extract_structured` interface
- provider-agnostic structured extraction evaluation, with Gemini on Vertex AI as one candidate when compliance requirements allow it

V2 should include or evaluate:

- `file.fetch_url` for direct links
- `web.extract_document_links`
- browser automation
- provider URL context as an agent capability
- autonomous web-scraping beyond simple URL/file fetching

The first customer should not need full browser use unless their document links require logged-in portals, JavaScript-heavy navigation, or interactive clicks.
