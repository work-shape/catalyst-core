# Document Text Extraction

Date: 2026-06-10

This note defines the first platform-native document processing tool. It is intentionally narrow: convert a managed file into text/Markdown so an agent can read it. It does not extract structured fields, compare claims, perform OCR, retrieve from a knowledge source, or acquire files from URLs.

## Shared Understanding

The first tool is:

```text
document.extract_text
```

It is a built-in platform tool, not a client-specific custom code tool. Client instances can enable or disable it through normal agent/tool configuration and permissions, but the conversion behavior, storage handling, audit behavior, and safeguards live in platform code.

The tool operates on a `Managed File`. It does not accept raw bytes, local paths, browser file objects, or URLs. Upload, handoff from a customer application, and future URL fetching are separate file acquisition concerns.

The output is extracted document text, preferably Markdown when the converter can preserve useful structure. For the first version, the agent should usually receive the full extracted text as-is. The platform still stores the extracted text as a managed artifact so retention, deletion, audit, and future UI references have a durable object to point at.

## Non-Goals

Do not include these in the first version:

- structured field extraction
- payslip-specific schemas
- comparison against application statements
- summarization as the primary output
- OCR or Gemini fallback
- browser automation
- URL/file fetching
- vector ingestion or retrieval
- arbitrary document-analysis UI beyond the normal tool result surface

These are future document processing capabilities that can build on the same managed file and artifact foundation.

## Runtime Shape

Recommended first implementation:

```text
agent
  -> document.extract_text
  -> tool authorization and audit envelope
  -> DocumentTextExtractionService
  -> ManagedFileStore reads source file
  -> MarkItDownRunner converts file through a child process
  -> ManagedArtifactStore writes extracted Markdown/text
  -> tool returns full text plus metadata
```

MarkItDown should be treated as the conversion engine behind the platform service, not as the product boundary. The product boundary remains `document.extract_text` and the product-owned extraction result types.

## MarkItDown Execution Model

Decision: for the first implementation, run MarkItDown through a child process from the Node backend/container. Do not introduce a separate document-worker container until OCR dependencies, scaling needs, memory isolation, or operational reliability justify it.

Reasons:

- The platform runtime is TypeScript/Node, while MarkItDown is Python.
- A child process gives a clear timeout, cancellation, stdout/stderr, and crash boundary.
- It avoids introducing an HTTP worker service, queue, or extra deployment unit before the workflow proves it needs one.
- The same service interface can later call a separate document-processing container if process isolation, scaling, OCR dependencies, or operational limits justify it.

The child process should run a small platform-owned Python wrapper, not a free-form shell command. Node should invoke it with `execFile` or equivalent argument-safe process execution.

The wrapper contract should be simple:

```text
input:
  source file path
  output artifact path
  optional source filename
  optional detected MIME type

work:
  run MarkItDown conversion locally
  write extracted Markdown/text to output artifact path

stdout:
  JSON metadata only

stderr:
  diagnostic text for platform logs, never returned to the agent by default
```

The wrapper must not fetch URLs or resolve remote resources. URL acquisition is a separate capability with its own network safety rules.

## Tool Contract

Suggested input:

```ts
type DocumentExtractTextInput = {
  fileId: string;
};
```

Suggested output:

```ts
type DocumentExtractTextOutput = {
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
    checksum?: string;
  };
  extraction: {
    engine: "markitdown";
    durationMs: number;
    warnings: string[];
  };
};
```

The agent receives `text` directly when it is within the configured agent-context limit. The platform must not silently truncate text. If extracted text is too large to safely return to the agent, the tool should fail with a clear error such as `too_large_for_agent_context`, while preserving the managed text artifact for later workflows.

## Safeguards

The first version should include safeguards that protect boundaries without changing the extracted content.

Required safeguards:

- verify the authenticated user may access the `fileId`
- accept only configured MIME types and file extensions
- enforce source file size limits
- enforce conversion wall-clock timeout
- cancel or kill the child process when the tool call is cancelled
- run conversion in a temporary working directory
- pass paths as process arguments, never through shell string interpolation
- disable URL conversion and remote fetching
- store extracted text as a retention-managed artifact
- avoid full extracted text in audit events, logs, and usage records
- mark document text as untrusted content in the agent system instructions or tool-result handling
- enforce a maximum returned text size for agent context

Recommended initial defaults:

```text
max source file size: 20 MB
max returned text size: 200,000 characters
conversion timeout: 30 seconds
supported first formats: PDF, DOCX, TXT, Markdown
```

These defaults are intentionally conservative and should be adjusted only when a concrete workflow requires it.

## Storage

Document text extraction needs managed object/artifact storage. Development should use an S3-compatible bucket as the normal path so file ids, object keys, metadata, checksums, streaming reads/writes, and deletion behavior are exercised early.

Recommended sequence:

1. Define product-owned managed file and artifact store interfaces.
2. Implement an S3-compatible object store adapter as the first real store.
3. Run a local S3-compatible service in Docker Compose for development.
4. Keep a filesystem or in-memory store only as a narrow unit-test fake if it materially simplifies tests.

Postgres should store metadata, ownership, retention state, checksums, and audit references. Raw files and extracted text artifacts should live in object/artifact storage.

LocalStack is the recommended development dependency when the production target is AWS S3 or AWS-compatible semantics. MinIO should not be the default local dependency for new work because the public `minio/minio` repository is now archived. Garage remains a possible future self-hosted S3-compatible production candidate for VPS/Compose deployments, but it does not need to be selected for the first extraction slice.

## Audit And Retention

Audit events should record metadata, not document content.

Recommended document events:

- `document.text_extraction_started`
- `document.text_extraction_completed`
- `document.text_extraction_failed`

Useful audit metadata:

- file id
- artifact id when created
- source MIME type
- source byte size
- extracted character count
- converter id and version when available
- warning count
- duration
- correlation id
- conversation id and tool call id through the existing tool audit envelope

Do not put extracted text, raw file bytes, prompts, or full converter stderr in audit events.

Retention and deletion should cover:

- source managed file
- extracted text artifact
- tool call record
- any future page-image or OCR artifacts

## Error Semantics

The tool should distinguish platform failures from conversion outcomes.

Platform failures:

- file not found
- user not authorized for file
- unsupported file type
- source file too large
- conversion timed out
- conversion process failed
- extracted text too large for agent context

Conversion outcomes:

- empty or near-empty text can be a successful conversion with a `no_extractable_text` warning
- partially extracted text can be a successful conversion with converter warnings
- scanned documents without OCR should return a warning, not trigger Gemini in the first version

## Future Extensions

Future capabilities should stay behind the same product concepts:

- OCR fallback for scanned PDFs or images
- provider-backed extraction through Vertex Gemini or another approved enterprise model provider
- structured field extraction as a separate capability
- comparison tools for application statements versus document facts
- document analysis UI panels
- S3-compatible artifact storage adapter
- isolated document-processing worker container

The agent-facing tool may remain `document.extract_text` for plain extraction. New interpretation behavior should be separate, for example `document.extract_structured` or a domain-specific analysis tool.

## Implementation Checklist

1. Add product-owned managed file/artifact store interfaces if the current `ManagedFileRef` and `ManagedArtifactRef` types are not enough.
2. Add an S3-compatible managed file/artifact store implementation.
3. Add a document processing package/module with `DocumentTextExtractionService`.
4. Add a MarkItDown child-process runner with timeout and cancellation support.
5. Add the Python wrapper script and dependency installation path for development/container builds.
6. Register the built-in `document.extract_text` tool through the existing tool registry.
7. Add agent instructions that treat extracted document text as untrusted content.
8. Add LocalStack or equivalent S3-compatible object storage to local Docker Compose.
9. Add tests for authorization, file-type rejection, file-size rejection, timeout, successful extraction, no-extractable-text warning, too-large-for-agent-context behavior, artifact creation, object deletion, and audit minimization.

## Open Questions

These are the remaining choices that need product agreement before implementation:

1. Which formats are required on day one: only PDF/DOCX/TXT/Markdown, or also XLSX/PPTX/HTML?
2. Should `too_large_for_agent_context` be a hard failure, or should the tool return artifact metadata without `text`?
3. Should the development S3-compatible service be LocalStack, or is there a stronger reason to use another S3-compatible service?
4. What exact retention duration applies to source files and extracted text artifacts for the first client instance?
