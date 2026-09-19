import { createHqmsAdaptor } from './hqms.ts';
import { createHn041Adaptor } from './hn041.ts';
import { createN041Adaptor } from './n041.ts';

export { createHqmsAdaptor, createHn041Adaptor, createN041Adaptor };
export type { BatchInputFormat, HospitalAdaptor, HospitalFormat, HospitalRow } from './common.ts';

/** Compile the selected column mapping once per file, then reuse adapt() for each row. */
export function createBatchAdaptor(format: string | null | undefined, headers: readonly string[]) {
  if (!format || format === 'MANUAL') return null;
  if (format === 'HQMS') return createHqmsAdaptor(headers);
  if (format === 'N041') return createN041Adaptor(headers);
  if (format === 'HN041') return createHn041Adaptor(headers);
  throw new Error(`不支持的批量格式：${format}`);
}
