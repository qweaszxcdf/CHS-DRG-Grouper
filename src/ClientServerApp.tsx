import { useEffect, useState } from 'react';

import SingleTab from './tabs/SingleTab.tsx';
import { checkGroupingServer } from './services/groupingGateway.ts';
import { DEFAULT_RULE_VERSION } from './services/generated/versionRegistry.ts';
import { listRuleVersions } from './services/versionedGrouper.ts';
import { useSearchIndex } from './hooks/useSearchIndex.ts';

export default function ClientServerApp() {
  const [searchSource, setSearchSource] = useState('YB');
  const [ruleVersion, setRuleVersion] = useState(DEFAULT_RULE_VERSION);
  const [serverStatus, setServerStatus] = useState('checking');
  const codeIndexRevision = useSearchIndex({ ruleVersion, searchSource });

  useEffect(() => {
    let active = true;
    checkGroupingServer()
      .then(() => { if (active) setServerStatus('online'); })
      .catch(() => { if (active) setServerStatus('offline'); });
    return () => { active = false; };
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, boxSizing: 'border-box' }}>
      <div className="w-full h-full dark-surface rounded-xl shadow-lg overflow-auto m-0 p-0 flex flex-col">
        <header className="bg-blue-600 p-6 text-white flex items-center justify-between flex-shrink-0">
          <div>
            <h1 className="text-3xl font-bold">DRG Grouper</h1>
            <p className="opacity-90">Diagnosis Related Group Assignment Engine</p>
          </div>

          <div className="flex items-center gap-4">
            <span
              className="inline-flex items-center gap-2 rounded-full border border-blue-300/60 bg-blue-900/30 px-3 py-1 text-xs font-semibold"
              title="Grouping requests are executed by the C/S service"
            >
              <span className={`h-2 w-2 rounded-full ${serverStatus === 'online' ? 'bg-green-300' : serverStatus === 'offline' ? 'bg-red-300' : 'bg-yellow-300'}`} />
              C/S {serverStatus === 'online' ? '在线' : serverStatus === 'offline' ? '离线' : '连接中'}
            </span>
            <label className="inline-flex items-center cursor-pointer select-none">
              <input
                type="checkbox"
                checked={searchSource === 'YB'}
                onChange={(event) => setSearchSource(event.target.checked ? 'YB' : 'GL')}
                className="sr-only"
                aria-label="使用医保码"
              />
              <span className={`relative inline-block h-5 w-10 rounded-full transition-colors duration-200 ease-in-out ${searchSource === 'YB' ? 'bg-blue-400' : 'bg-gray-600'}`}>
                <span className={`absolute left-1 top-0.5 h-4 w-4 bg-white rounded-full shadow transform transition-transform duration-200 ${searchSource === 'YB' ? 'translate-x-4' : 'translate-x-0'}`} />
              </span>
              <span className="ml-3 text-sm text-white">使用医保码</span>
            </label>
          </div>
        </header>

        <div className="p-6">
          <div className="px-4 pt-3 flex items-center gap-2">
            <label htmlFor="rule-version" className="text-sm text-gray-500">DRG版本</label>
            <select id="rule-version" value={ruleVersion} onChange={(event) => setRuleVersion(event.target.value)} className="border rounded px-2 py-1 text-sm">
              {listRuleVersions().map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
          <SingleTab searchSource={searchSource} version={ruleVersion} codeIndexRevision={codeIndexRevision} />
        </div>
      </div>
    </div>
  );
}
