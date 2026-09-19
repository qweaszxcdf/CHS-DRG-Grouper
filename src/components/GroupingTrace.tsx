import type { MatchTraceEntry, MatchTraceEvent } from '../types/grouper.ts';

export interface GroupingTraceProps {
  trace: MatchTraceEntry[];
  principalProcedure?: string;
  onViewInMdcTree?: (code: string) => void;
}

const TRACE_STAGE_LABELS: Record<MatchTraceEvent, string> = {
  validation: 'Validation',
  'mdcz-category-check': 'Pre-MDC',
  'pre-mdc-match': 'Pre-MDC',
  'mdc-match': 'MDC',
  'adrg-match': 'ADRG',
  'adrg-no-match': 'ADRG',
  'qy-redirect': 'QY Redirect',
  'cc-status': 'CC/MCC',
  'subgroup-match': 'DRG',
  'subgroup-no-match': 'DRG',
  transport: 'Transport',
};

function hasVisibleDetail(entry: MatchTraceEntry): boolean {
  const sections = entry.detail?.ruleMatch?.details.sections
    ?? entry.detail?.adrgRule?.details.sections;

  return Boolean(
    entry.status
    || Object.keys(sections ?? {}).length > 0
    || entry.mdczDiagnosisMatches?.length
    || entry.candidates?.length,
  );
}

function TraceDetail({ entry }: { entry: MatchTraceEntry }) {
  const sections = Object.entries(
    entry.detail?.ruleMatch?.details.sections
    ?? entry.detail?.adrgRule?.details.sections
    ?? {},
  );
  const categories = new Map<string, string[]>();

  for (const match of entry.mdczDiagnosisMatches ?? []) {
    for (const category of match.categories) {
      categories.set(category, [
        ...(categories.get(category) ?? []),
        match.code,
      ]);
    }
  }

  if (!hasVisibleDetail(entry)) return null;

  return (
    <div className="mt-1 text-xs text-gray-300 pl-3 border-l-2 border-gray-500">
      {entry.status && (
        <div>
          Level: <span className="font-bold">{entry.status.toUpperCase()}</span>
        </div>
      )}
      {entry.event === 'mdcz-category-check'
        && entry.actualCategoryCount !== undefined
        && entry.requiredCategoryCount !== undefined
        && entry.actualCategoryCount < entry.requiredCategoryCount
        && (
          <div className="italic">
            Requires at least {entry.requiredCategoryCount} distinct trauma
            categories; matched {entry.actualCategoryCount}
          </div>
        )}
      {[...categories].map(([category, codes]) => (
        <div key={category}>
          <span className="rounded bg-gray-700 px-1.5 py-0.5">{category}</span>
          {' '}
          <span className="font-mono">{codes.join(', ')}</span>
        </div>
      ))}
      {sections.map(([name, section]) => (
        <div
          key={name}
          className={`p-1 rounded ${section.matched ? 'text-success' : 'text-gray-400'}`}
        >
          <div className="flex items-center gap-2">
            <span className="font-bold">{section.matched ? '●' : '○'}</span>
            <span className="font-medium">{name}</span>
          </div>
          <div className="text-xs ml-5 mt-1">
            {section.matchedCodes && section.matchedCodes.length > 0 ? (
              <div>
                Matched codes:
                {' '}
                <span className="font-mono">{section.matchedCodes.join(', ')}</span>
              </div>
            ) : (
              <div className="text-gray-400">No matching codes</div>
            )}
          </div>
        </div>
      ))}
      {entry.candidates && (
        <div>
          Evaluated {entry.candidateCount ?? entry.candidates.length} detailed
          rules ({entry.candidates.map(candidate => candidate.code).join(', ')})
        </div>
      )}
    </div>
  );
}

function TraceStep({
  entry,
  ccStatus,
  principalProcedure,
  onViewInMdcTree,
}: {
  entry: MatchTraceEntry;
  ccStatus?: string;
  principalProcedure: string;
  onViewInMdcTree?: (code: string) => void;
}) {
  return (
    <div
      className={`p-2 rounded-lg border flex flex-col gap-1 ${
        entry.matched
          ? 'bg-success-muted border-success'
          : (entry.matched === false
              ? 'bg-error-muted border-error'
              : 'bg-gray-800 border-gray-600')
      }`}
    >
      <div className="flex justify-between items-center">
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-700 border-gray-600 border text-gray-300">
          {TRACE_STAGE_LABELS[entry.event]}
        </span>
        {entry.matched !== undefined && (
          <span
            className={`text-[10px] font-bold ${
              entry.matched ? 'text-success' : 'text-error'
            }`}
          >
            {entry.matched ? '✓ Match' : '✗ No Match'}
          </span>
        )}
      </div>
      <div className="font-medium text-sm flex items-baseline gap-2">
        {entry.code && (
          <span className="font-mono font-bold text-blue-400">{entry.code}</span>
        )}
        <span className="text-gray-200">{entry.description}</span>
      </div>
      {ccStatus && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <span className="rounded bg-gray-700 px-1.5 py-0.5 text-gray-200">
            CC status: {ccStatus}
          </span>
        </div>
      )}
      {entry.event === 'qy-redirect'
        && onViewInMdcTree
        && principalProcedure
        && (
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onViewInMdcTree(principalProcedure)}
              className="flex items-center gap-1.5 rounded border border-cyan-900/70 bg-cyan-950/30 px-2 py-1 text-xs text-cyan-200 hover:border-cyan-700 hover:bg-cyan-900/40"
            >
              <span className="text-gray-400">主手术</span>
              <span className="font-mono">{principalProcedure}</span>
              <span>在 MDC Tree 中查看</span>
            </button>
          </div>
        )}
      <TraceDetail entry={entry} />
    </div>
  );
}

export function GroupingTrace({
  trace,
  principalProcedure = '',
  onViewInMdcTree,
}: GroupingTraceProps) {
  const procedureCode = principalProcedure.trim();

  const hasMatchedSubgroup = trace.some(
    entry => entry.event === 'subgroup-match',
  );
  const ordinaryCc = hasMatchedSubgroup
    ? trace.find(
        entry => entry.event === 'cc-status'
          && entry.status
          && !entry.overridden
          && !entry.strategy,
      )
    : undefined;
  const visible = trace.filter(
    entry => entry !== ordinaryCc
      && !(
        ['mdc-match', 'pre-mdc-match', 'adrg-match'].includes(entry.event)
        && entry.matched === true
        && !hasVisibleDetail(entry)
      )
      && !(entry.event === 'subgroup-match' && !hasVisibleDetail(entry)),
  );

  if (!visible.length) return null;

  return (
    <section
      className="mt-6 space-y-3 rounded-xl border dark-border bg-gray-950/70 p-3"
      aria-label="Grouping Trace"
    >
      <h4 className="text-sm font-bold tracking-wider text-gray-200">
        Grouping Trace
      </h4>
      <div className="space-y-2">
        {visible.map((entry, index) => (
          <TraceStep
            key={index}
            entry={entry}
            ccStatus={
              entry.event === 'subgroup-match'
                ? ordinaryCc?.status?.toUpperCase()
                : undefined
            }
            principalProcedure={procedureCode}
            onViewInMdcTree={onViewInMdcTree}
          />
        ))}
      </div>
    </section>
  );
}
