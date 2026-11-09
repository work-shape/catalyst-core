/** Formats the built-in Knowledge Base keeps; all but text need document processing. */
export const KNOWLEDGE_DOCUMENT_FORMATS = [
  "txt",
  "markdown",
  "pdf",
  "docx",
  "xlsx",
  "pptx"
] as const;
export type KnowledgeDocumentFormat = (typeof KNOWLEDGE_DOCUMENT_FORMATS)[number];
