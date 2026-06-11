import type { JsonObject } from "@vivd-catalyst/core";

export interface OpenAiCompatibleUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAiCompatibleResponse {
  usage?: OpenAiCompatibleUsage;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type?: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
}

export interface OpenAiCompatibleRequestBody {
  model: string;
  messages: OpenAiCompatibleMessage[];
  tools: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: JsonObject;
    };
  }>;
  tool_choice?: "auto";
}

export type OpenAiCompatibleMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };
