declare module 'papaparse' {
  export interface ParseError {
    type?: string;
    code?: string;
    message?: string;
    row?: number;
    [key: string]: unknown;
  }

  export interface ParseMeta {
    fields?: string[];
    [key: string]: unknown;
  }

  export interface ParseResult<T> {
    data: T[];
    errors: ParseError[];
    meta: ParseMeta;
  }

  export interface ParseConfig {
    header?: boolean;
    skipEmptyLines?: boolean;
    [key: string]: unknown;
  }

  interface PapaParse {
    parse<T = unknown>(input: string, config?: ParseConfig): ParseResult<T>;
    unparse(input: unknown): string;
  }

  const Papa: PapaParse;
  export default Papa;
}
