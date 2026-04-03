export interface KBConfig {
  name: string;
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  paths: {
    raw: string;
    wiki: string;
    output: string;
    meta: string;
  };
}

export interface RawDocument {
  id: string;
  title: string;
  source: string; // file path or URL
  type: 'article' | 'paper' | 'repo' | 'note' | 'other';
  ingestedAt: string;
  hash: string; // content hash for change detection
  path: string; // path in raw/
}

export interface WikiArticle {
  id: string;
  title: string;
  category: string;
  summary: string;
  sources: string[]; // raw doc IDs
  path: string; // path in wiki/
  updatedAt: string;
}

export interface KBState {
  lastCompile: string | null;
  rawDocuments: Record<string, RawDocument>;
  wikiArticles: Record<string, WikiArticle>;
  compiledHashes: Record<string, string>; // rawId -> hash at last compile
}

export interface CompileResult {
  newArticles: string[];
  updatedArticles: string[];
  totalRawProcessed: number;
}

export interface IndexEntry {
  title: string;
  path: string;
  category: string;
  summary: string;
}
