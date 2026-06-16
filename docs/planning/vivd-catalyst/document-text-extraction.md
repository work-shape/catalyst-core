# Document Preprocessing And Reading

Date: 2026-06-10
Updated: 2026-06-16

This note defines the first platform-native document preprocessing and reading path. It is intentionally narrow: after file acquisition, supported text-related documents are converted into reusable text/Markdown artifacts and safe metadata. The agent then uses a normal tool to read the prepared text. This does not extract structured fields, compare claims, perform OCR, retrieve from a knowledge source, or acquire files from URLs.

## Shared Understanding

The v1 flow is:

```text
file upload or handoff
  -> File Acquisition creates a Managed File
  -> DocumentPreprocessingService runs for supported text-related files
  -> text/Markdown artifact and metadata are persisted
  -> send persists an Attachment Manifest snapshot with file refs plus preprocessing metadata
  -> agent calls read_document when it needs the text
  -> read_document returns prepared text as persisted model-visible tool output
```

Document preprocessing is automatic for supported uploaded/attached documents in v1. The agent does not trigger extraction itself. The agent only chooses whether and when to call `read_document`.

The first agent-facing tool is:

```text
read_document
```

It is a built-in platform tool, not a client-specific custom code tool. Client instances can enable or disable it through normal agent/tool configuration and permissions, but the preprocessing behavior, storage handling, audit behavior, and safeguards live in platform code.

`read_document` operates on a prepared `Managed File`. It does not accept raw bytes, local paths, browser file objects, or URLs. Upload, handoff from a customer application, and future URL fetching are separate file acquisition concerns.

In v1, `read_document` is conversation-scoped. The tool may read only files attached to the current conversation, either as current Draft Attachments or as attachments on sent messages in that conversation. User-level file ownership is necessary but not sufficient; a file from another conversation must not be readable unless future explicit file-library behavior is added.

Prepared text artifacts are also conversation-scoped in v1. Even if the same source file is attached in multiple conversations, each conversation attachment may get its own prepared artifact. This avoids cross-conversation cache/version semantics when the preprocessing pipeline changes. A future file-library or deduplication feature can introduce reusable prepared artifacts with explicit versioning.

V1 should not deduplicate preprocessing even when the same file appears to be attached twice in the same conversation. Each Draft Attachment has its own preprocessing state and prepared artifact. The UI may warn on likely duplicates, such as matching filename and size, and ask whether the user wants to upload again; if the user continues, treat it as a separate attachment.

The output is prepared document text, preferably Markdown when the converter can preserve useful structure. For v1, supported documents should normally be read in full. The platform also stores the extracted text as a managed artifact so retention, deletion, audit, future page-range reads, and future UI references have a durable object to point at.

## Non-Goals

Do not include these in v1:

- structured field extraction
- payslip-specific schemas
- comparison against application statements
- summarization as a primary output
- table-of-contents generation
- page-range reading
- OCR or Gemini fallback
- browser automation
- URL/file fetching
- vector ingestion or retrieval
- arbitrary document-analysis UI beyond normal processing status and tool result surfaces

These are future document processing capabilities that can build on the same managed file and artifact foundation.

## Runtime Shape

Recommended first implementation:

```text
chat UI drop/upload
  -> create Conversation shell if the user is on the unsent New conversation screen
  -> upload/acquisition API stores raw file as Managed File
  -> persistent Draft Attachment is created for the conversation
  -> DocumentPreprocessingService
  -> ManagedFileStore reads source file
  -> format-specific converter prepares text through a child process
  -> ManagedArtifactStore writes extracted Markdown/text
  -> Postgres stores preprocessing status, counts, warnings, artifact refs
  -> send persists an Attachment Manifest snapshot on the user message
  -> agent chooses read_document(fileId)
  -> InProcessToolExecution authorization, input validation, and generic tool audit envelope
  -> read_document ToolDefinition loads prepared artifact
  -> tool returns ToolHandlerResult output plus artifact/audit metadata
  -> ModelContextProjection sends model-visible output to the agent
```

Converters should be treated as implementation details behind the platform service, not as the product boundary. The product boundaries are Document Preprocessing, `read_document`, and future page-view tools, using product-owned result types. MarkItDown can remain a converter for formats such as DOCX where stable page boundaries are not intrinsic. PDF handling should move to a platform-owned PDF adapter because page-indexed text and visual page reads are core product behavior.

## Alignment With Live Tool Runtime

The live tool architecture already has the right outer shape:

- tools are `ToolDefinition`s created with the tool SDK
- client assembly combines platform built-ins and customer tools
- release config enables/disables tools and agents reference enabled tool names
- `InProcessToolExecution` authorizes tools, validates input/output schemas, executes handlers, and records generic `tool.*` audit events
- `ToolHandlerResult` separates model-visible `output`, non-model `privateOutput`, user-facing `display`, managed `artifacts`, and minimized `auditSummary`
- `ModelContextProjection` serializes only `output` into model-visible history and applies a configurable tool-output bound

`read_document` should therefore be a normal built-in platform tool using this contract. Its model-visible `output` contains the prepared text and is persisted as durable agent-visible tool history. The prepared text artifact should also be returned through `artifacts` so retention, deletion, UI references, and future workflows can use the durable object without parsing model-visible output.

The current client assembly creates built-in tool definitions before creating the platform store. That works for stateless built-ins such as `show_view`, but `read_document` needs managed file/artifact storage. The cleanest implementation is to create the platform store and storage-backed platform services before creating built-in tool definitions, then pass those services into the built-in factory:

```text
load config
create platform store
create managed file/artifact stores
create DocumentPreprocessingService
create DocumentReadService
create built-in tool definitions with service dependencies
create customer tool definitions
validate assembly
create ToolRegistry and InProcessToolExecution
```

This keeps `read_document` as a normal tool while keeping storage access in runtime dependencies instead of model-visible tool input. Avoid a special lazy lookup inside the tool handler unless the assembly order becomes circular; explicit construction is easier to validate and test.

## Upload-Time Processing State

When a file is dropped or otherwise attached to a conversation, the chat surface should block message submission until preprocessing reaches a terminal state for all files that require preprocessing.

Draft Attachments must be persisted, not kept only in component memory. Switching conversations, navigating away, refreshing the browser, or reopening the standalone surface should restore upload and preprocessing state. Composer text can remain frontend state in v1; the backend should not persist every keystroke.

If the user drops a file on the unsent New conversation screen, the frontend should create a persisted Conversation shell first. Draft Attachments are always owned by `conversationId`; do not introduce a separate draft-owner id in v1.

Conversations created by file drop should use a temporary file-based title. For one file, use the filename; for multiple files, use a generic count such as `3 attached files`. Filename-based titles are acceptable in the user's own conversation list because the user uploaded the file and needs to recognize the conversation. Do not put filename-derived titles into audit metadata unless there is a specific governance reason. After the first real user message and assistant response, the normal backend title-generation flow can replace the title if it still looks temporary.

Preprocessing should start immediately after each file drop/upload, but it must not block the user from dropping additional files or typing the message. Only message submission is blocked while any Draft Attachment is still uploading, queued, preprocessing, failed, or unsupported. The backend should persist status transitions so the UI can refetch or poll attachment state after refresh or conversation switches.

Suggested statuses:

```text
uploading
uploaded
queued
preprocessing
ready
unsupported
failed
deleted
```

The UI should show a clear processing state in the chat/composer area. Pre-send attachment chips should stay minimal: filename, status, and file size. Do not show extracted text, and do not require word/page counts in this UI. The user should not be able to send a message with a file that is still `uploading`, `queued`, or `preprocessing`. A failed or unsupported file should remain visible with a clear error and a remove/retry path. For v1, sending is disabled until every failed or unsupported Draft Attachment is removed or retried successfully; unavailable files should not enter the Attachment Manifest.

Preprocessing should start immediately after each file drop/upload, but it must not block the user from dropping additional files or typing the message. Multiple Draft Attachments may preprocess independently, but concurrency must be bounded and configurable. Recommended initial defaults:

```text
per-conversation preprocessing concurrency: 2
global preprocessing concurrency: implementation-defined, conservative default
```

When concurrency is exhausted, additional ready-to-process Draft Attachments should stay in `queued` until capacity is available. The backend should persist status transitions so the UI can refetch or poll attachment state after refresh or conversation switches.

Preprocessing policy should live in release config, not agent config:

```yaml
documents:
  preprocessing:
    enabled: true
    perConversationConcurrency: 2
    globalConcurrency: 4
    maxSourceFileSizeMb: 20
    maxPreparedTextCharacters: 200000
    timeoutSeconds: 30
    supportedFormats:
      - pdf
      - docx
      - txt
      - md
```

The default global concurrency should be conservative, but operated client instances can raise it after sizing the VPS/container CPU, memory, and child-process behavior. The first customer deployment should choose a value explicitly during infrastructure sizing rather than relying on an accidental code default.

Preprocessing enablement does not automatically grant agent read access. `read_document` remains an explicit tool that must be enabled in release config and referenced by each agent that may read prepared document text:

```yaml
tools:
  - name: read_document
    enabled: true

agents:
  - name: workflow_assistant
    toolNames:
      - read_document
```

On send, the backend should attach the conversation's ready Draft Attachments to the new user message, persist an Attachment Manifest snapshot on that message, and clear those Draft Attachments from the conversation. Because v1 blocks send until every included Draft Attachment is ready, the manifest should not need to change after it enters conversation history. This gives the persisted conversation a clear record of which prepared files the model saw as available for that message. Retention/deletion workflows should handle removed, abandoned, failed, or orphaned Draft Attachments and their managed files/artifacts.

Queued-send is out of scope for v1. A future version may let the user press send while files are still processing, show the message as waiting, and release it to the agent only after preprocessing succeeds. V1 keeps the simpler rule: no user message is created until all included attachments are ready and the user explicitly sends.

## Attachment Manifest

The model-visible Attachment Manifest should expose metadata, not raw document text.

Suggested manifest entry:

```ts
type AttachmentManifestEntry = {
  fileId: string;
  filename?: string;
  mimeType?: string;
  byteSize?: number;
  checksum?: string;
  preprocessing: {
    status: "ready";
    format?: "markdown" | "text";
    pageCount?: number;
    wordCount?: number;
    characterCount?: number;
    warnings: string[];
    readable: boolean;
  };
};
```

For v1, the manifest should include word/character counts from the prepared text. `pageCount` is best-effort optional metadata: include it only when the source format or converter exposes a reliable page count. If page count is not reliable for a format, omit it rather than inventing an estimate.

The manifest is there so the agent can decide whether to call `read_document`. It must not include full prepared text. In v1, the manifest includes only sendable ready files; unsupported or failed Draft Attachments block send until removed or retried. Empty or near-empty prepared text is still sendable as `ready` with a `no_extractable_text` warning and zero or near-zero counts.

## Converter Execution Model

Decision: for the first implementation, run preprocessing in the API process and run format-specific converters through child processes from the Node backend/container. Do not introduce a separate document-worker process or container in v1. Revisit that only when OCR dependencies, scaling needs, memory isolation, or operational reliability justify it.

Reasons:

- The platform runtime is TypeScript/Node, while PDF extraction and document conversion dependencies are native or Python tools.
- A child process gives a clear timeout, cancellation, stdout/stderr, and crash boundary.
- It avoids introducing an HTTP worker service, queue, or extra deployment unit before the workflow proves it needs one.
- The same service interface can later call a separate document-processing container if process isolation, scaling, OCR dependencies, or operational limits justify it.

The child process should run a small platform-owned wrapper, not a free-form shell command. Node should invoke it with `execFile` or equivalent argument-safe process execution.

The wrapper contract should be simple:

```text
input:
  source file path
  output artifact path
  optional source filename
  optional detected MIME type

work:
  run format-specific conversion locally
  write extracted Markdown/text to output artifact path

stdout:
  JSON metadata only

stderr:
  diagnostic text for platform logs, never returned to the agent by default
```

The wrapper must not fetch URLs or resolve remote resources. URL acquisition is a separate capability with its own network safety rules.

For PDFs, the preferred wrapper should use Poppler `pdfinfo` for preflight metadata and page count, `pdfplumber` for page-by-page text extraction, `pypdf` only as a fallback for simple text extraction or metadata cases, and Poppler `pdftoppm` for on-demand page rendering. Avoid making PyMuPDF the default dependency unless the project explicitly accepts its AGPL/commercial licensing path.

## Tool Contract

V1 input is intentionally only full-document reading:

```ts
type ReadDocumentInput = {
  fileId: string;
};
```

V1 model-visible output:

```ts
type ReadDocumentOutput = {
  file: {
    fileId: string;
    filename?: string;
    mimeType?: string;
    checksum?: string;
  };
  text: string;
  format: "markdown" | "text";
  textArtifact: {
    artifactId: string;
    mimeType: "text/markdown" | "text/plain";
    characterCount: number;
    wordCount?: number;
    pageCount?: number;
    checksum?: string;
  };
  preprocessing: {
    engine: "markitdown" | "platform_pdf";
    completedAt: string;
    durationMs: number;
    warnings: string[];
  };
};
```

The output should keep structured metadata beside the raw prepared text. Do not prepend a prose metadata header to `text`; `text` should remain only the prepared document content.

The successful tool result should also include:

```ts
{
  artifacts: [
    {
      artifactId,
      kind: "document.prepared_text",
      mimeType: "text/markdown" | "text/plain",
      filename
    }
  ],
  auditSummary: {
    action: "read_document",
    subject: fileId,
    metadata: {
      artifactId,
      characterCount,
      wordCount,
      pageCount,
      warningCount
    }
  }
}
```

The agent receives `text` directly and the full model-visible output is persisted in durable conversation/tool history. The platform must not silently truncate document text inside the read tool result. If a later model request needs context management, session compaction or model-context projection can bound the active provider request without rewriting the durable transcript.

## PDF Page-Aware Extraction And Visual Page Reads

PDF page awareness should build on the preprocessing state instead of changing the upload/read boundary. For PDFs, the platform should move away from MarkItDown as the extraction boundary and use a platform-owned adapter with a stable product contract.

Recommended PDF preprocessing dependencies:

- Poppler `pdfinfo` for preflight metadata, encryption status, page count, and page-size metadata
- `pdfplumber` for page-by-page text extraction and future word/position/table-oriented extraction
- `pypdf` as a narrow fallback for simple extraction or metadata cases when useful
- Poppler `pdftoppm` for rendering specific pages to PNG on demand

The platform-owned part is the adapter contract, storage shape, authorization, audit behavior, and tool behavior. The platform should not implement a PDF parser itself.

For PDFs, preprocessing should persist:

- the original PDF as the source managed file
- a full prepared text artifact
- a structured page-text JSON artifact
- reliable `pageCount` metadata
- per-page character and word counts
- per-page warnings, such as `no_extractable_text`

Suggested structured page artifact:

```ts
type PreparedPdfPage = {
  pageNumber: number;
  text: string;
  characterCount: number;
  wordCount?: number;
  warnings: string[];
};

type PreparedPdfPagesArtifact = {
  format: "pdf";
  pageCount: number;
  pages: PreparedPdfPage[];
};
```

The full prepared text may join page text with explicit delimiters such as `[Page 1]`, but those delimiters are for readability only. The structured page artifact is the source of truth for page-range reads and page-specific citations.

Do not render page images during upload-time preprocessing. Page images are expensive relative to text extraction, and most conversations will not need visual inspection of every page.

`read_document` can extend v1 only after the page-text artifact exists:

```ts
type ReadDocumentInput = {
  fileId: string;
} & (
  | {
      mode: "full";
    }
  | {
      mode: "pages";
      pages: {
        from: number;
        to: number;
      };
    }
);
```

Do not expose page-range parameters in v1 unless the preprocessing pipeline actually persists page-indexed text. A parameter that implies page precision without page-indexed artifacts would create false confidence.

The page visual inspection tool should be named:

```text
view_document_page
```

Prefer `view_document_page` over `see_page`, `view_page`, or `visually_inspect_page`. `see_page` is too informal and ambiguous, `view_page` collides with browser/web pages, and `visually_inspect_page` describes what the agent does after the tool runs rather than what the tool itself does.

Suggested input:

```ts
type ViewDocumentPageInput = {
  fileId: string;
  pageNumber: number;
  render?: {
    dpi?: 150 | 160 | 200;
  };
};
```

`view_document_page` should:

1. Verify the authenticated user may access the file and that the file is attached to the current conversation.
2. Verify the file is a PDF with a known page count and that `pageNumber` is in range.
3. Render only the requested page from the original PDF with Poppler `pdftoppm`.
4. Use a conservative default such as PNG at 150 or 160 DPI, with 200 DPI reserved for small text.
5. Enforce output byte, pixel, timeout, and per-conversation rate limits.
6. Persist the rendered PNG as a managed artifact with a deterministic artifact key that includes file id, page number, DPI, and source checksum or preprocessing version.
7. Represent the image as a managed artifact with kind `document.page_image`.
8. Return a normal tool result whose model-visible `output` includes file id, page number, page count, render metadata, and the page-image artifact reference.
9. Include the page-image artifact in the tool result `artifacts` list.
10. Project the rendered page image into the agent's visual/model context for the next provider call.

The rendered page image is agent-visible tool output, not only UI display data. It must be persisted through durable message/tool history in the same way as other model-visible tool outputs: the tool call input, validated output, artifact reference, and successful or failed execution state all remain in conversation history.

Because API-model calls do not retain image bytes across requests by themselves, the platform must keep every active model-visible page image projectable. The preferred v1 implementation is to persist rendered PNG bytes as normal conversation-scoped managed artifacts and delete them through the same retention/deletion policy as the conversation, source file, and prepared document artifacts.

When a later provider request includes the visual history, `ModelContextProjection` loads the retained PNG artifact and the provider adapter serializes it in the provider's required format, such as a base64 data URL for APIs that use inline image inputs. Re-encoding bytes for a provider request is acceptable and should stay out of durable history; if it ever becomes a measurable cost, cache the encoded provider payload as an optimization, not as the source of truth.

Later model-context projection may omit, downsample, or replace the image with an artifact marker when context bounds or compaction require it, but that is a projection decision and must not rewrite or erase the durable transcript. Avoid storing base64 image data inside message history; store the artifact reference and metadata, and keep bytes in managed artifact storage.

DOCX page boundaries should remain explicitly weaker than PDF page boundaries. A DOCX document has no stable page model without choosing a layout engine and rendering configuration, so DOCX should keep full-text conversion first. Add DOCX page-aware behavior only if the product accepts a deterministic rendering dependency and documents the limits.

## Page-Aware PDF Implementation Plan

This implementation can break the current v1 converter/storage shape. Optimize the new code around explicit artifacts, page-aware reads, and multimodal projection rather than preserving the current single-text `MarkItDownDocumentTextConverter` boundary.

Implementation target:

- `document.prepared_text`: retained full-text artifact for explicit full-document reads, exports, and debugging
- `document.pages_json`: retained page-indexed PDF text artifact for page-range reads and page-specific citations
- `document.page_image`: retained rendered PNG artifact for model-visible visual inspection
- message/tool history stores artifact references and metadata, never base64 image data
- model-provider adapters serialize retained image bytes into provider-specific request formats at projection time

The most important model-context invariant is:

```text
Stored artifacts are not automatically projected into model context.
The model sees only the exact text returned by a tool call, plus image artifacts that a tool result intentionally marks as model-visible visual context.
```

This prevents double-loading. Even though storage keeps both `document.prepared_text` and `document.pages_json`, `read_document(mode: "full")` returns only the full-text artifact content, `read_document(mode: "pages")` returns only the requested page texts, and `view_document_page` returns only page-image metadata plus the model-visible image artifact. No tool should return full text and all page text in the same result.

Recommended implementation sequence:

1. Replace `DocumentTextConverter` with a product-owned `DocumentPreprocessor` contract that can return full text, optional PDF page text, page count, warnings, and engine metadata.
2. Add first-class managed artifact metadata in Postgres, backed by object storage bytes. Artifacts should include kind, MIME type, checksum, byte size, conversation id, source file id, retention metadata, and object key.
3. Replace direct `preparedObjectKey` attachment state with artifact ids such as `preparedTextArtifactId` and `preparedPagesArtifactId`. Keep attachment-level counts, page count, status, warnings, and preprocessing engine.
4. Implement the PDF preprocessor wrapper around Poppler `pdfinfo` and `pdfplumber`. It should emit metadata JSON and write full text/page JSON outputs through platform-controlled paths. Use MarkItDown only for DOCX/general full-text conversion, not for PDFs.
5. Persist PDF preprocessing outputs as separate managed artifacts: full text as `document.prepared_text`, page JSON as `document.pages_json`.
6. Make `read_document` mode explicit. `mode: "full"` reads only the full-text artifact. `mode: "pages"` reads the page JSON artifact and returns only the requested page range. Large PDFs can reject or require explicit confirmation for full reads.
7. Add `view_document_page`. It renders one PDF page on demand with `pdftoppm`, persists the PNG as `document.page_image`, returns artifact metadata, and marks the artifact as model-visible visual context.
8. Widen `ToolExecutionResult` artifact metadata or add a model-context hint so a result can say which artifacts are model-visible images. Do not infer model visibility from artifact kind alone if that would make future private image artifacts unsafe.
9. Replace string-only `ModelMessage.content` with content parts, such as `{ type: "text", text }` and `{ type: "image", artifactId, mimeType }`. Keep text helpers for normal messages.
10. Make `ModelContextProjection` artifact-aware. It should replay tool text outputs exactly as stored, include model-visible image artifact references as image parts when policy allows, and never expand `document.prepared_text` or `document.pages_json` merely because an artifact reference exists.
11. Update the OpenAI-compatible provider mapping to load image artifact bytes from managed artifact storage and serialize them as provider request image inputs, such as base64 data URLs. Base64 remains request-only and is not persisted in history.
12. Add projection bounds for visual artifacts: max images per request, max image bytes/pixels, recency ordering, and explicit artifact-marker notices when an older visual artifact is omitted.
13. Hook retention/deletion so source files, prepared text, page JSON, page images, attachment rows, and tool-result artifact references are cleaned up together according to conversation/session policy.
14. Add tests at the artifact boundary, tool boundary, projection boundary, provider mapping boundary, and retention boundary.

Test cases should include:

- PDF preprocessing creates one full-text artifact and one page JSON artifact with matching page count
- the attachment manifest exposes only metadata and no prepared text/page text
- `read_document(mode: "full")` returns full text but not page JSON
- `read_document(mode: "pages")` returns selected pages but not full text
- `view_document_page` returns a page-image artifact without base64 in history
- repeated `view_document_page` can reuse an existing page-image artifact for the same file checksum, page number, and DPI
- model-context projection does not expand text artifacts automatically
- model-context projection includes page images only when the tool result marked them model-visible
- provider mapping encodes retained image bytes into request-time image inputs
- context bounding can omit older images with a model-visible artifact marker without mutating durable history
- retention deletes original PDF, prepared text, page JSON, and page-image artifacts together

## Safeguards

The first version should include safeguards that protect boundaries without changing the prepared content.

Required safeguards:

- verify the authenticated user may access the `fileId`
- verify the file is attached to the current conversation
- accept only configured MIME types and file extensions
- enforce source file size limits
- enforce preprocessing wall-clock timeout
- cancel or kill the child process when preprocessing is cancelled or abandoned
- run conversion in a temporary working directory
- pass paths as process arguments, never through shell string interpolation
- disable URL conversion and remote fetching
- store prepared text as a retention-managed artifact
- avoid full prepared text in audit events, logs, usage records, and Attachment Manifests
- mark prepared document text as untrusted content in agent system instructions or tool-result handling
- enforce a generous maximum persisted prepared text size to prevent pathological tool outputs
- persist Draft Attachment preprocessing state so refresh/conversation switching cannot lose attachment readiness

V1 supported formats:

- PDF
- DOCX
- TXT
- Markdown

HTML, XLSX, and PPTX are out of scope for v1 unless a concrete first-customer document requires changing the scope.

Recommended initial defaults:

```text
max source file size: 20 MB
max persisted prepared text size: 200,000 characters
preprocessing timeout: 30 seconds
supported first formats: PDF, DOCX, TXT, Markdown
```

These defaults are intentionally conservative and should be adjusted only when a concrete workflow requires it.

## Storage

Document preprocessing needs managed object/artifact storage. Development should use an S3-compatible bucket as the normal path so file ids, object keys, metadata, checksums, streaming reads/writes, and deletion behavior are exercised early.

Recommended sequence:

1. Define product-owned managed file, prepared document, and artifact store interfaces if the current `ManagedFileRef` and `ManagedArtifactRef` types are not enough.
2. Implement an S3-compatible object store adapter as the first real store.
3. Run Adobe S3Mock in Docker Compose for development and CI.
4. Keep a filesystem or in-memory store only as a narrow unit-test fake if it materially simplifies tests.

Postgres should store metadata, ownership, conversation attachment links, retention state, preprocessing status, counts, warnings, checksums, preprocessing version metadata, and audit references. Raw files and prepared text artifacts should live in object/artifact storage. In v1, prepared text artifact metadata should point to the conversation attachment it was created for, not only to the source file.

Adobe S3Mock is the selected development and CI object-store dependency for the first implementation. It is Apache-2.0 licensed, Docker-friendly, and explicitly intended for local S3 integration testing. It is not a production object store.

LocalStack should not be the default development dependency because its current licensing and auth-token model adds avoidable friction for this project. MinIO should not be the default local dependency for new work because the public `minio/minio` repository is now archived. Garage remains a possible future self-hosted S3-compatible production candidate for VPS/Compose deployments, but it does not need to be selected for the first extraction slice.

## Audit And Retention

Audit events should record metadata, not document content.

The live runtime already records generic `tool.authorization_checked`, `tool.started`, `tool.completed`, and `tool.failed` events. `read_document` should not bypass that envelope. Document-specific preprocessing metadata should be recorded directly by the preprocessing service or through a minimized audit-summary path.

Recommended document events:

- `document.preprocessing_started`
- `document.preprocessing_completed`
- `document.preprocessing_failed`
- `document.read_completed`
- `document.read_failed`

Useful audit metadata:

- file id
- artifact id when created or read
- source MIME type
- source byte size
- prepared character count
- prepared word count
- page count when reliable
- converter id and version when available
- warning count
- duration
- correlation id
- conversation id and tool call id where a read happened through the tool envelope

Do not put prepared text, raw file bytes, prompts, or full converter stderr in audit events.

Retention and deletion should cover:

- source managed file
- prepared text artifact
- conversation attachment links
- preprocessing metadata
- tool call record
- any future page-index, TOC, summary, page-image, or OCR artifacts

Exact retention durations are release-config policy and do not block this design. The important v1 requirement is that raw files, Draft Attachments, prepared artifacts, preprocessing metadata, and message/tool references all participate in the configured retention and deletion workflows.

## Error Semantics

Preprocessing failures:

- unsupported file type
- source file too large
- preprocessing timed out
- conversion process failed
- prepared text exceeds the configured maximum persisted prepared text size

Read failures:

- file not found
- user not authorized for file
- file is not attached to the current conversation
- preprocessing not completed
- preprocessing failed or unsupported
- prepared text artifact missing

Conversion outcomes:

- empty or near-empty text can be successful preprocessing with a `no_extractable_text` warning
- partially prepared text can be successful preprocessing with converter warnings
- scanned documents without OCR should return a warning, not trigger Gemini in v1

## Implementation Checklist

1. Add product-owned managed file/artifact/prepared-document store interfaces if the current types are not enough.
2. Add an S3-compatible managed file/artifact store implementation.
3. Add a document processing package/module with `DocumentPreprocessingService` and `DocumentReadService`.
4. Add persistent Draft Attachment state for conversation attachments so refresh and conversation switching restore status.
5. Create a Conversation shell on first file drop when no `conversationId` exists yet.
6. Add a format-specific converter child-process runner with timeout and cancellation support.
7. Add the PDF wrapper script and dependency installation path for Poppler `pdfinfo`, Poppler `pdftoppm`, `pdfplumber`, and `pypdf`.
8. Keep a MarkItDown or equivalent wrapper for DOCX/general text conversion, but do not use it as the PDF page-boundary contract.
9. Persist PDF page-text JSON artifacts, PDF page counts, and page-aware counts/warnings when PDF preprocessing succeeds.
10. Add `documents.preprocessing` release config for enablement, supported formats, size/text limits, timeout, and concurrency.
11. Wire file upload/acquisition finalization to start non-blocking preprocessing for supported text-related files.
12. Add configurable preprocessing concurrency with queued Draft Attachments when capacity is exhausted.
13. Block chat submission while attached files are uploading, queued, preprocessing, failed, or unsupported.
14. Persist an Attachment Manifest snapshot on the user message at send time.
15. Project the persisted Attachment Manifest into model-visible user messages.
16. Add a service-backed built-in `read_document` tool definition through the existing tool registry and client assembly path.
17. Extend `read_document` with explicit `mode: "full"` and `mode: "pages"` reads only after page-text artifacts are available, and enforce that no response returns both full text and all page text.
18. Add a service-backed built-in `view_document_page` tool that renders one PDF page on demand, persists a `document.page_image` artifact, and projects the image into agent visual context.
19. Adjust client assembly construction so the platform store and storage-backed services are created before built-in tool definitions that depend on them.
20. Add agent instructions that treat prepared document text and rendered page images as untrusted content.
21. Add Adobe S3Mock to local Docker Compose.
22. Add tests for upload-time preprocessing, persisted Draft Attachment state, conversation-scoped prepared artifacts, duplicate-file warning without deduplication, release-config validation, configurable concurrency/queueing, new-conversation file drop, refresh/conversation restoration, send-time clearing, persisted Attachment Manifest snapshots, send blocking for uploading/queued/preprocessing/failed/unsupported attachments, authorization, conversation-scoped read access, file-type rejection, file-size rejection, timeout, successful full-text read, PDF page-text artifact creation, page-range reads, no full-plus-all-pages double projection, no-extractable-text warning, oversized prepared text failure, artifact creation, page-image rendering, page-image artifact persistence, page-image model-context projection, object deletion, Attachment Manifest projection, model-context projection boundaries, and audit minimization.

## Open Questions

No document-preprocessing-specific product blockers remain before implementation. Exact retention durations and first-client concurrency values are release/deployment configuration decisions.
