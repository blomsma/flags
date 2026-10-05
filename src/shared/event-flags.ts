import catalogue from './event-flags.json';
import type { CeremonySlot, FlagDefinition } from './types';

export const eventFlags = catalogue;
const byCode = new Map(eventFlags.filter(flag => flag.code).map(flag => [flag.code, flag]));
const byId = new Map(eventFlags.map(flag => [flag.id, flag]));

/** Custom uploads take precedence. Existing presets outside the event list keep working. */
export function resolveFlag(slot: CeremonySlot, customFlags: FlagDefinition[]): { name: string; imageUrl: string | null } {
  const custom = customFlags.find(flag => flag.id === slot.flagId);
  if (custom) return custom;
  const flag = (slot.flagId ? byId.get(slot.flagId) : undefined) ?? byCode.get(slot.countryCode.toUpperCase());
  if (flag) return flag;
  const code = slot.countryCode.trim().toUpperCase();
  return { name: code, imageUrl: `/flags/4x3/${encodeURIComponent(code.toLowerCase())}.svg` };
}
