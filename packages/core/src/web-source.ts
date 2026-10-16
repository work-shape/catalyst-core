import { WEB_SOURCE_PROVIDERS } from "@work-shape/catalyst-asset-schemas";
export type WebSourceProvider =
  (typeof WEB_SOURCE_PROVIDERS)[number];

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
