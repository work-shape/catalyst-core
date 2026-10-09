export interface MigrationStatement {
  /** The statement without comments, literals blanked, for messages. */
  sql: string;
  /** What rules match: upper-case keywords, `{n}` for quoted identifiers, `''` for literals. */
  shape: string;
  identifiers: string[];
  comments: string[];
}

export interface MigrationChunk {
  text: string;
  statements: MigrationStatement[];
}

export interface ParsedMigration {
  chunks: MigrationChunk[];
  malformedBreakpoints: string[];
}

export const statementBreakpoint: string;
export const qualifiedNamePattern: string;
export function parseMigration(text: string): ParsedMigration;
export function parseSqlChunk(text: string): MigrationStatement[];
export function statementName(statement: MigrationStatement, token: string): string;
export function runsOutsideTransaction(statement: MigrationStatement): boolean;
export function concurrentIndexName(statement: MigrationStatement): string | undefined;
