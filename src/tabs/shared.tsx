import type { CodeSearchItem } from '../types/search.ts';

export interface CodeInfo {
  desc: string;
  type: string;
  searchResults: CodeSearchItem[];
  showDropdown: boolean;
  highlightedIndex: number;
}

// Shared utilities used across tab components

export const createEmptyInfo = (overrides: Partial<CodeInfo> = {}): CodeInfo => ({
  desc: '',
  type: '',
  searchResults: [],
  showDropdown: false,
  highlightedIndex: -1,
  ...overrides,
});

export function reorder<T>(list: T[], startIndex: number, endIndex: number) {
  const result = Array.from(list);
  const [removed] = result.splice(startIndex, 1);
  result.splice(endIndex, 0, removed!);
  return result;
}

export function ensureSingleTrailingEmpty(list: string[]) {
  const cleaned = list.filter((s) => s.trim() !== '');
  cleaned.push('');
  return cleaned;
}

export function normalizeCodesAndInfos(codes: string[], infos: CodeInfo[]) {
  const newCodes = [];
  const newInfos = [];
  const prevCodes = codes;
  const prevInfos = infos;
  for (let i = 0; i < prevCodes.length; i++) {
    const c = prevCodes[i] ?? '';
    if (c.trim() !== '') {
      newCodes.push(c);
      newInfos.push(prevInfos[i] ? prevInfos[i]! : createEmptyInfo());
    }
  }
  newCodes.push('');
  newInfos.push(createEmptyInfo());
  return { codes: newCodes, infos: newInfos };
}

export const reorderWithInfos = (prevCodes: string[], prevInfos: CodeInfo[], from: number, to: number) => {
  const reordered = reorder(prevCodes, from, to);
  const normalized = ensureSingleTrailingEmpty(reordered);
  const newInfos = [];
  const used = new Set();
  for (let i = 0; i < normalized.length; i++) {
    const codeVal = normalized[i];
    let found = -1;
    for (let j = 0; j < prevCodes.length; j++) {
      if (used.has(j)) continue;
      if ((prevCodes[j] ?? '') === codeVal) { found = j; break; }
    }
    if (found !== -1) {
      used.add(found);
      newInfos.push(prevInfos[found] || createEmptyInfo());
    } else {
      newInfos.push(createEmptyInfo());
    }
  }
  return { normalized, newInfos };
};

export const MAX_EDIT_DISTANCE = 1;
export function namesSignificantlyDiffer(a: string, b: string) {
  const sa = a.trim();
  const sb = b.trim();
  if (sa === sb) return false;
  const la = sa.length, lb = sb.length;
  if (Math.abs(la - lb) > MAX_EDIT_DISTANCE) return true;
  if (la === lb) {
    let subs = 0;
    for (let i = 0; i < la; i++) {
      if (sa[i] !== sb[i] && ++subs > MAX_EDIT_DISTANCE) return true;
    }
    return false;
  }
  const [shorter, longer] = la < lb ? [sa, sb] : [sb, sa];
  let si = 0, li = 0, skips = 0;
  while (si < shorter.length && li < longer.length) {
    if (shorter[si] === longer[li]) { si++; li++; }
    else { li++; if (++skips > MAX_EDIT_DISTANCE) return true; }
  }
  return false;
}

export function truncateStr(str: string, max = 120) {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

export function highlightMatch(text: string, q: string, isRegex = false) {
  if (!q) return text;
  const s = text;
  if (isRegex) {
    try {
      const re = new RegExp(q, 'gi');
      const parts = [];
      let lastIndex = 0;
      let match;
      let key = 0;
      while ((match = re.exec(s)) !== null) {
        const idx = match.index;
        const len = match[0].length;
        if (idx > lastIndex) parts.push(<span key={`${s}-p-${key++}`}>{s.slice(lastIndex, idx)}</span>);
        parts.push(<mark key={`${s}-m-${key++}`} className="bg-yellow-300 text-black rounded px-0.5">{s.slice(idx, idx + len)}</mark>);
        lastIndex = idx + len;
        if (len === 0) re.lastIndex++;
      }
      if (lastIndex < s.length) parts.push(<span key={`${s}-p-${key++}`}>{s.slice(lastIndex)}</span>);
      return parts;
    } catch {
      return text;
    }
  }
  const needle = q.toLowerCase();
  const lc = s.toLowerCase();
  const parts = [];
  let lastIndex = 0;
  let idx = lc.indexOf(needle, lastIndex);
  let key = 0;
  while (idx !== -1) {
    if (idx > lastIndex) parts.push(<span key={`${s}-p-${key++}`}>{s.slice(lastIndex, idx)}</span>);
    parts.push(<mark key={`${s}-m-${key++}`} className="bg-yellow-300 text-black rounded px-0.5">{s.slice(idx, idx + needle.length)}</mark>);
    lastIndex = idx + needle.length;
    idx = lc.indexOf(needle, lastIndex);
  }
  if (lastIndex < s.length) parts.push(<span key={`${s}-p-${key++}`}>{s.slice(lastIndex)}</span>);
  return parts;
}
