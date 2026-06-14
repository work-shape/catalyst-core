import type { JsonObject, ReasoningEffortConfig } from "@vivd-catalyst/core";

export interface OpenAiCompatibleUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAiResponsesUsage {
  input_tokens: number;
  output_tokens: number;
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
  reasoning_effort?: ReasoningEffortConfig;
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

export interface OpenAiResponsesRequestBody {
  model: string;
  input: OpenAiResponseInput;
  reasoning?: {
    effort: ReasoningEffortConfig;
  };
  tools: OpenAiResponsesTool[];
  tool_choice?: "auto";
  stream?: boolean;
  store?: boolean;
}

export type OpenAiResponsesTool = {
  type: "function";
  name: string;
  description: string;
  parameters: JsonObject;
  strict: false;
};

export type OpenAiResponseInput = OpenAiResponseInputItem[];

export type OpenAiResponseInputItem =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

export interface OpenAiResponsesResponse {
  output?: OpenAiResponsesOutputItem[];
  output_text?: string;
  usage?: OpenAiResponsesUsage;
}

export type OpenAiResponsesOutputItem =
  | {
      type: "message";
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

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
