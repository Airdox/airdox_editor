/** Pure SystemLogModal filtering contract, including ERROR/FATAL grouping and
 * every supported category. Live additions themselves are covered by the
 * LoggerService subscriber tests. */
import assert from 'node:assert/strict';
import { filterSystemLogEntries } from '../src/components/Modals/SystemLogModal';
import type { LogEntry } from '../src/utils/logger';

const logs: LogEntry[] = [
  { id: '1', timestamp: 1, timeString: '00:00:01.000', level: 'DEBUG', category: 'DATABASE', message: 'ANLZ tags', details: { tags: ['PWV5'] } },
  { id: '2', timestamp: 2, timeString: '00:00:02.000', level: 'INFO', category: 'UI', message: 'Track request applied', details: { requestId: 3 } },
  { id: '3', timestamp: 3, timeString: '00:00:03.000', level: 'WARN', category: 'CHATBOT', message: 'Fallback warning', details: { origin: 'GENERATED_FALLBACK' } },
  { id: '4', timestamp: 4, timeString: '00:00:04.000', level: 'ERROR', category: 'DATABASE', message: 'MASTER_DB_OPEN_FAILED' },
  { id: '5', timestamp: 5, timeString: '00:00:05.000', level: 'FATAL', category: 'SYSTEM', message: 'Unhandled Promise Rejection' },
];

assert.equal(filterSystemLogEntries(logs, { level: 'ALL', category: 'ALL', query: '' }).length, 5);
assert.deepEqual(
  filterSystemLogEntries(logs, { level: 'ERROR', category: 'ALL', query: '' }).map((entry) => entry.id),
  ['4', '5'],
  'ERROR filter intentionally includes FATAL entries'
);
assert.deepEqual(
  filterSystemLogEntries(logs, { level: 'ALL', category: 'CHATBOT', query: '' }).map((entry) => entry.id),
  ['3']
);
assert.deepEqual(
  filterSystemLogEntries(logs, { level: 'ALL', category: 'UI', query: 'request' }).map((entry) => entry.id),
  ['2']
);
assert.deepEqual(
  filterSystemLogEntries(logs, { level: 'ALL', category: 'DATABASE', query: 'pwv5' }).map((entry) => entry.id),
  ['1'],
  'detail search remains available for FourCC diagnostics'
);

console.log('system log modal model: OK');
