/**
 * Time-range window shared by the dashboard pages and the <RangeToggle> chips.
 * The data layer (getSessions/getUsage/getAllTranscripts) honors any daysBack,
 * but the UI only exposes these fixed windows — parseDays clamps to them so a
 * hand-edited ?days= can't trigger an unbounded transcript scan.
 */
export const RANGES = [7, 30, 90] as const;
export const DEFAULT_DAYS = 30;

export function parseDays(raw?: string | string[]): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return (RANGES as readonly number[]).includes(n) ? n : DEFAULT_DAYS;
}
