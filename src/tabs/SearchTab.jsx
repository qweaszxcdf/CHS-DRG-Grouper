import { memo, useCallback, useState, useMemo } from 'react';
import { Search, Copy, Check } from 'lucide-react';
import { searchCodes } from '../services/CodeSearch';

const SearchResultRow = memo(function SearchResultRow({ item, isCopied, onCopy }) {
  return (
    <tr className="border-b dark-border last:border-0 hover:bg-info hover:bg-opacity-20 transition">
      <td className="p-3 font-mono font-bold text-blue-400">{item.code}</td>
      <td className="p-3 text-gray-200">{item.name}</td>
      <td className="p-3">
        <span className={`px-2 py-1 rounded text-xs font-bold border ${
          item.type === 'Diagnosis' ? 'bg-warning bg-opacity-30 text-warning border-warning' :
          item.type === 'Procedure' ? 'bg-purple-500 bg-opacity-30 text-purple-300 border-purple-400' :
          item.type === 'DRG' ? 'bg-success bg-opacity-30 text-success border-success' :
          'bg-gray-600 bg-opacity-30 text-gray-300 border-gray-500'
        }`}>
          {item.type}
        </span>
      </td>
      <td className="p-3">
        <button
          onClick={() => onCopy(item.code)}
          className="text-gray-400 hover:text-blue-400 transition"
          title="Copy Code"
        >
          {isCopied ? <Check size={18} className="text-success" /> : <Copy size={18} />}
        </button>
      </td>
    </tr>
  );
});

export default function SearchTab({ searchSource, version, codeIndexRevision = 0 }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState('All'); // 'All', 'Diagnosis', 'Procedure', 'ADRG', 'DRG'
  const [copiedCode, setCopiedCode] = useState(null);

  const handleCopy = useCallback((text) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(text);
    setTimeout(() => setCopiedCode(null), 1500);
  }, []);

  const searchResults = useMemo(() => {
    if (!searchQuery || codeIndexRevision === 0) return [];
    try {
      return searchCodes(searchQuery, searchType, searchSource, version) || [];
    } catch {
      return [];
    }
  }, [searchQuery, searchType, searchSource, version, codeIndexRevision]);

  return (
    <div className="space-y-6">
      <div className="dark-surface p-6 rounded-lg border dark-border shadow-sm">
        <h2 className="text-xl font-bold mb-4 text-gray-100">Code Dictionary Search</h2>
        <div className="flex flex-col gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-3 text-gray-300" size={20} />
            <input
              type="text"
              className="w-full pl-10 p-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder={`Search ${searchType === 'All' ? 'everything' : searchType.toLowerCase() + 's'}...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex items-center gap-4">
            <div className="flex gap-2 p-1 dark-surface-2 rounded-lg w-fit">
              {['All', 'Diagnosis', 'Procedure', 'ADRG', 'DRG'].map((type) => (
                <button
                  key={type}
                  onClick={() => setSearchType(type)}
                  className={`px-4 py-1.5 rounded-md text-xs font-bold transition ${searchType === type
                    ? 'dark-surface text-blue-400 shadow-sm border dark-border'
                    : 'text-gray-400 hover:text-gray-200'
                    }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4">
          {searchResults.length === 0 ? (
            <p className="text-gray-400 text-center py-8">
              {searchQuery ? 'No results found.' : 'Start typing to search diagnoses, procedures, and DRGs.'}
            </p>
          ) : (
            <div className="overflow-x-auto border dark-border rounded-lg max-h-[600px]">
              <table className="w-full text-left text-sm">
                <thead className="border-b dark-border sticky top-0 bg-gray-900">
                  <tr>
                    <th className="p-3 font-semibold w-32 text-gray-200">Code</th>
                    <th className="p-3 font-semibold text-gray-200">Description</th>
                    <th className="p-3 font-semibold w-24 text-gray-200">Type</th>
                    <th className="p-3 font-semibold w-16 text-gray-200">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((item, i) => (
                    <SearchResultRow
                      key={item.code + i}
                      item={item}
                      isCopied={copiedCode === item.code}
                      onCopy={handleCopy}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
