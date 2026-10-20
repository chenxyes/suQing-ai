/** Shared, IO-free memory admission rules. Management readers deliberately do not use these. */
export function isMemoryRecallable(row) {
  return !!row && (row.memory_status ?? 'active') === 'active'
    && Number(row.do_not_mention ?? 0) === 0 && Number(row.recall_blocked ?? 0) === 0;
}

export function memorySourceIds(value) {
  if (value == null) return null; // legacy: provenance unknown
  try {
    const ids = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(ids) || !ids.every(id => Number.isSafeInteger(id) && id > 0)) return false;
    return [...new Set(ids)];
  } catch { return false; }
}

export function filterRecallableMemoryRows(rows, { hasRevocations = false, recallRevision = hasRevocations ? 1 : 0 } = {}) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const memo = new Map();
  const visiting = new Set();
  function admitted(row) {
    if (!isMemoryRecallable(row)) return false;
    if (memo.has(row.id)) return memo.get(row.id);
    if (visiting.has(row.id)) return false; // invalid provenance cycle
    const sources = memorySourceIds(row.source_memory_ids);
    const summary = row.memory_layer === 'summary' || /_summary$/.test(row.memory_type || '');
    if (sources === false || (sources === null && summary && hasRevocations)) return false;
    // [] means conversation-derived, not independent of all previous conversation facts.
    if (sources?.length === 0 && Number(row.source_recall_revision ?? 0) !== recallRevision) return false;
    visiting.add(row.id);
    const ok = !sources || sources.every(id => {
      const source = byId.get(id);
      return source && source.companion_id === row.companion_id
        && String(source.user_id) === String(row.user_id) && admitted(source);
    });
    visiting.delete(row.id);
    memo.set(row.id, ok);
    return ok;
  }
  return rows.filter(admitted);
}
