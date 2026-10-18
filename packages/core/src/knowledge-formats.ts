/** Formats the built-in Knowledge Base keeps; PDF and DOCX need document processing. */
export const KNOWLEDGE_DOCUMENT_FORMATS = ["txt", "markdown", "pdf", "docx"] as const;
export type KnowledgeDocumentFormat = (typeof KNOWLEDGE_DOCUMENT_FORMATS)[number];
