export type CodeSearchSource = 'YB' | 'GL' | 'ALL';

export interface CodeSearchItem {
  code: string;
  name: string;
  type: string;
  source?: CodeSearchSource;
  initials?: string;
}

export interface CodeIndexState {
  codeIndex: CodeSearchItem[];
  buckets: Record<string, CodeSearchItem[]>;
  isBuilt: boolean;
  glBuilt?: boolean;
}
