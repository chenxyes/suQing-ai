/**
 * Compatibility entry for the retired automatic-history sandbox.
 * Automatic creation/binding/watermark generation is disabled. This entry now
 * runs the offline smoke suite using its own temporary database and no model.
 * Run synthetic_history_generation_check.mjs with --experimental-vm-modules to
 * exercise explicitly confirmed fictional generation with a controlled model.
 */
console.log('Automatic history sandbox retired; running offline synthetic-history checks (no model calls).');
await import('./backfill_auto_smoke.mjs');
