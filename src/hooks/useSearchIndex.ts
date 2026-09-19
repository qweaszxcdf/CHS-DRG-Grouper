import { useEffect, useState } from 'react';
import { buildCodeIndex, preloadGLCodeIndex } from '../services/CodeSearch.ts';
import { preloadRuleVersion } from '../services/versionedGrouper.ts';
import type { VersionId } from '../types/grouper.js';

interface SearchIndexOptions {
  ruleVersion: VersionId;
  searchSource: string;
}

export function useSearchIndex({ ruleVersion, searchSource }: SearchIndexOptions): number {
  const [codeIndexRevision, setCodeIndexRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const prepareSearchIndex = async (): Promise<void> => {
      try {
        await preloadRuleVersion(ruleVersion);
        buildCodeIndex(ruleVersion);
        if (searchSource === 'GL') await preloadGLCodeIndex(ruleVersion);
        if (active) setCodeIndexRevision((value) => value + 1);
      } catch (error: unknown) {
        if (active) console.error(`Failed to prepare code search for ${ruleVersion}/${searchSource}:`, error);
      }
    };
    prepareSearchIndex();
    return () => { active = false; };
  }, [ruleVersion, searchSource]);

  return codeIndexRevision;
}
