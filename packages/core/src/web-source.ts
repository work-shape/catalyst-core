export type WebSourceProvider =
  | "openai-native"
  | "serper"
  | "tavily"
  | "firecrawl"
  | "browserbase"
  | "direct";

export interface WebSource {
  id: string;
  url: string;
  title?: string;
  provider: WebSourceProvider;
  query?: string;
  retrievedAt?: string;
  snippet?: string;
  contentHash?: string;
  resultPosition?: number;
}

export interface MessageCitation {
  sourceId: string;
  label?: string;
  quote?: string;
  characterRange?: {
    start: number;
    end: number;
  };
}
