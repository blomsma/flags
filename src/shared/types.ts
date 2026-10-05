export type Rank = 1 | 2 | 3;
export type FinialStyle = 'sphere' | 'flat' | 'spear';
export type BackgroundType = 'transparent' | 'color' | 'image' | 'video';
export type ShadowQuality = 'low' | 'medium' | 'high';
export type MeshResolution = 'standard' | 'high' | 'ultra';
export interface FlagDefinition { id: string; name: string; imageUrl: string; }
export interface CeremonySlot { id: string; rank: Rank; countryCode: string; flagId?: string; xOffset: number; }
export interface CeremonySettings {
  slots: CeremonySlot[]; customFlags: FlagDefinition[]; hoistDuration: number; stagger: number; mastSpacing: number; flagWidth: number; flagHeight: number; meshResolution: MeshResolution;
  windStrength: number; windStartPercent: number; windDirection: number; windGustiness: number; windTurbulence: number;
  cloth: { selfCollision: boolean; collisionThickness: number; collisionIterations: 1 | 2; };
  flagMaterial: { gloss: number; metalness: number; clearcoat: number; clearcoatGloss: number; };
  pole: { visible: boolean; heightScale: number; finialSize: number; gloss: number; color: string; thickness: number; finialStyle: FinialStyle; finialColor: string; };
  lighting: { sunAzimuth: number; sunElevation: number; sunIntensity: number; sunColor: string; shadowsEnabled: boolean; shadowSoftness: number; shadowQuality: ShadowQuality; };
  background: { type: BackgroundType; color: string; url: string; };
}
export interface CeremonyState { settings: CeremonySettings; revision: number; lastExecuteId: string | null; executeAt: number | null; executeEndAt: number | null; executeDuration: number; executeStagger: number; serverTime: number; motion: 'idle' | 'up' | 'down'; }
export type ClientMessage = { type: 'hello'; role: 'ceremony' | 'control' } | { type: 'update'; settings: CeremonySettings } | { type: 'execute'; settings: CeremonySettings; executeId: string } | { type: 'hoist'; direction: 'up' | 'down'; executeId?: string };
export type ServerMessage = { type: 'state'; state: CeremonyState } | { type: 'executed'; state: CeremonyState };
export const DEFAULT_SETTINGS: CeremonySettings = {
  slots: [{ id: 'silver', rank: 2, countryCode: 'IT', xOffset: 0 }, { id: 'gold', rank: 1, countryCode: 'NL', xOffset: 0 }, { id: 'bronze', rank: 3, countryCode: 'DE', xOffset: 0 }], customFlags: [], hoistDuration: 8, stagger: 3, mastSpacing: 4, flagWidth: 3.2, flagHeight: 2.1, meshResolution: 'high',
  windStrength: .6, windStartPercent: 0, windDirection: 90, windGustiness: 0, windTurbulence: .73,
  cloth: { selfCollision: true, collisionThickness: .2, collisionIterations: 2 },
  flagMaterial: { gloss: .4, metalness: .5, clearcoat: 0, clearcoatGloss: 0 },
  pole: { visible: true, heightScale: 1.6, finialSize: 1, gloss: .76, color: '#e8edf2', thickness: .11, finialStyle: 'sphere', finialColor: '#e8edf2' },
  lighting: { sunAzimuth: -35, sunElevation: 42, sunIntensity: 3.6, sunColor: '#ffffff', shadowsEnabled: false, shadowSoftness: .55, shadowQuality: 'high' },
  background: { type: 'color', color: '#000000', url: '' }
};
export const cloneSettings = (v: CeremonySettings): CeremonySettings => JSON.parse(JSON.stringify(v)) as CeremonySettings;
const rec = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const num = (v: unknown, f: number, min: number, max: number): number => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : f; };
const txt = (v: unknown, f: string, max: number): string => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : f;
const col = (v: unknown, f: string): string => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : f;
const bool = (v: unknown, f: boolean): boolean => typeof v === 'boolean' ? v : f;
/** Canonical normalization and legacy migration used by server and control. */
export function normalizeSettings(value: unknown): CeremonySettings {
  const source = rec(value) ? value : {};
  const rawSlots = Array.isArray(source.slots) ? source.slots : DEFAULT_SETTINGS.slots;
  // Legacy migration only: old athlete labels are intentionally discarded.
  const slots = rawSlots.slice(0, 12).map((raw, index): CeremonySlot => { const item = rec(raw) ? raw : {}; const fallback = DEFAULT_SETTINGS.slots[index % 3]; const old = typeof item.athlete === 'string' ? item.athlete : ''; return { id: txt(item.id, `slot-${index + 1}`, 64), rank: (item.rank === 1 || item.rank === 2 || item.rank === 3 ? item.rank : fallback.rank) as Rank, countryCode: /^[a-z]{2}$/i.test(String(item.countryCode ?? '')) ? String(item.countryCode).toUpperCase() : fallback.countryCode, xOffset: num(item.xOffset, 0, -30, 30), ...(typeof item.flagId === 'string' && item.flagId.trim() ? { flagId: item.flagId.trim().slice(0, 80) } : old.startsWith('flag:') ? { flagId: old.slice(5, 85) } : {}) }; });
  const customFlags = (Array.isArray(source.customFlags) ? source.customFlags : []).slice(0, 100).flatMap((raw, index) => { if (!rec(raw)) return []; const imageUrl = txt(raw.imageUrl, '', 2048); if (!imageUrl) return []; const id = txt(raw.id, `custom-${index + 1}`, 80); return [{ id, name: txt(raw.name, id, 120), imageUrl }]; });
  const cloth = rec(source.cloth) ? source.cloth : {}, flagMaterial = rec(source.flagMaterial) ? source.flagMaterial : {}, pole = rec(source.pole) ? source.pole : {}, lighting = rec(source.lighting) ? source.lighting : {}, background = rec(source.background) ? source.background : {};
  const backgroundType = background.type === 'transparent' || background.type === 'image' || background.type === 'video' || background.type === 'color' ? background.type : DEFAULT_SETTINGS.background.type;
  const ids = new Set<string>(); slots.forEach((slot, i) => { let id = slot.id, n = 2; while (ids.has(id)) id = `${slot.id}-${n++}`; ids.add(id); slots[i] = { ...slot, id }; });
  const resolutionValue = source.meshResolution;
  const meshResolution: MeshResolution = resolutionValue === 'high' || resolutionValue === 'ultra' || resolutionValue === 'standard'
    ? resolutionValue
    : typeof resolutionValue === 'number' ? (resolutionValue >= 3 ? 'ultra' : resolutionValue >= 2 ? 'high' : 'standard') : DEFAULT_SETTINGS.meshResolution;
  return { slots: slots.length ? slots : DEFAULT_SETTINGS.slots.map((s) => ({ ...s })), customFlags, hoistDuration: num(source.hoistDuration, DEFAULT_SETTINGS.hoistDuration, 1, 180), stagger: num(source.stagger, DEFAULT_SETTINGS.stagger, 0, 60), mastSpacing: num(source.mastSpacing, DEFAULT_SETTINGS.mastSpacing, 1, 30), flagWidth: num(source.flagWidth, DEFAULT_SETTINGS.flagWidth, .1, 20), flagHeight: num(source.flagHeight, DEFAULT_SETTINGS.flagHeight, .1, 20), meshResolution, windStrength: num(source.windStrength, DEFAULT_SETTINGS.windStrength, 0, 1), windStartPercent: num(source.windStartPercent, DEFAULT_SETTINGS.windStartPercent, 0, 100), windDirection: num(source.windDirection, DEFAULT_SETTINGS.windDirection, -180, 180), windGustiness: num(source.windGustiness, DEFAULT_SETTINGS.windGustiness, 0, 1), windTurbulence: num(source.windTurbulence, DEFAULT_SETTINGS.windTurbulence, 0, 1), cloth: { selfCollision: bool(cloth.selfCollision, DEFAULT_SETTINGS.cloth.selfCollision), collisionThickness: num(cloth.collisionThickness, DEFAULT_SETTINGS.cloth.collisionThickness, .01, .2), collisionIterations: num(cloth.collisionIterations, DEFAULT_SETTINGS.cloth.collisionIterations, 1, 2) >= 1.5 ? 2 : 1 }, flagMaterial: { gloss: num(flagMaterial.gloss, DEFAULT_SETTINGS.flagMaterial.gloss, 0, 1), metalness: num(flagMaterial.metalness, DEFAULT_SETTINGS.flagMaterial.metalness, 0, 1), clearcoat: num(flagMaterial.clearcoat, DEFAULT_SETTINGS.flagMaterial.clearcoat, 0, 1), clearcoatGloss: num(flagMaterial.clearcoatGloss, DEFAULT_SETTINGS.flagMaterial.clearcoatGloss, 0, 1) }, pole: { visible: bool(pole.visible, DEFAULT_SETTINGS.pole.visible), heightScale: num(pole.heightScale, DEFAULT_SETTINGS.pole.heightScale, .5, 1.8), finialSize: num(pole.finialSize, DEFAULT_SETTINGS.pole.finialSize, 0, 3), gloss: num(pole.gloss, DEFAULT_SETTINGS.pole.gloss, 0, 1), color: col(pole.color, DEFAULT_SETTINGS.pole.color), thickness: num(pole.thickness, DEFAULT_SETTINGS.pole.thickness, .01, 1), finialStyle: pole.finialStyle === 'flat' || pole.finialStyle === 'spear' || pole.finialStyle === 'sphere' ? pole.finialStyle : DEFAULT_SETTINGS.pole.finialStyle, finialColor: col(pole.finialColor, DEFAULT_SETTINGS.pole.finialColor) }, lighting: { sunAzimuth: num(lighting.sunAzimuth, DEFAULT_SETTINGS.lighting.sunAzimuth, -180, 180), sunElevation: num(lighting.sunElevation, DEFAULT_SETTINGS.lighting.sunElevation, 0, 90), sunIntensity: num(lighting.sunIntensity, DEFAULT_SETTINGS.lighting.sunIntensity, 0, 10), sunColor: col(lighting.sunColor, DEFAULT_SETTINGS.lighting.sunColor), shadowsEnabled: bool(lighting.shadowsEnabled, DEFAULT_SETTINGS.lighting.shadowsEnabled), shadowSoftness: num(lighting.shadowSoftness, DEFAULT_SETTINGS.lighting.shadowSoftness, 0, 1), shadowQuality: lighting.shadowQuality === 'low' || lighting.shadowQuality === 'medium' || lighting.shadowQuality === 'high' ? lighting.shadowQuality : DEFAULT_SETTINGS.lighting.shadowQuality }, background: { type: backgroundType, color: col(background.color, DEFAULT_SETTINGS.background.color), url: txt(background.url, '', 2048) } };
}
