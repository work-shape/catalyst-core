/** The wire format of Gemini `generateContent` on Vertex AI. Nothing outside the adapter reads it. */

export interface VertexPart {
  text?: string;
  /** True for a part of the model's reasoning, which is not part of its answer. */
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface VertexContent {
  role: "user" | "model";
  parts: VertexPart[];
}

/** The subset of an OpenAPI schema that Vertex takes for tool parameters and answer formats. */
export interface VertexSchema {
  type?: string;
  format?: string;
  description?: string;
  nullable?: boolean;
  enum?: string[];
  properties?: Record<string, VertexSchema>;
  required?: string[];
  items?: VertexSchema;
  anyOf?: VertexSchema[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

export interface VertexGenerateContentRequest {
  contents: VertexContent[];
  systemInstruction?: { parts: VertexPart[] };
  tools?: { functionDeclarations: VertexFunctionDeclaration[] }[];
  generationConfig?: {
    temperature?: number;
    responseMimeType?: string;
    responseSchema?: VertexSchema;
  };
}

interface VertexFunctionDeclaration {
  name: string;
  description: string;
  parameters?: VertexSchema;
}

export interface VertexUsageMetadata {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
}

export interface VertexGenerateContentResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: {
    content?: { parts?: VertexPart[] };
    finishReason?: string;
  }[];
  usageMetadata?: VertexUsageMetadata;
}
