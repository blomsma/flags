import * as THREE from 'three';
import { resolveFlag } from '../shared/event-flags';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type CeremonySettings,
  type CeremonySlot,
  type CeremonyState,
  type ServerMessage,
  type FinialStyle,
} from '../shared/types';
import { ClothSimulation, type ClothSnapshot } from './cloth';

type ActiveFlag = {
  slot: CeremonySlot;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  material: THREE.MeshPhysicalMaterial;
  cloth: ClothSimulation;
  snapshot?: ClothSnapshot;
  phase: number;
  hoist: number;
  hoistFrom: number;
  hoistTarget: number;
  hoistStartAt: number;
  hoistDurationMs: number;
  hidden: boolean;
};

type ClothOptions = {
  selfCollision: boolean;
  collisionThickness: number;
  collisionIterations: 1 | 2;
};

type FlagMaterialOptions = {
  gloss: number;
  metalness: number;
  clearcoat: number;
  clearcoatGloss: number;
};

type RendererSettings = CeremonySettings & {
  cloth: ClothOptions;
  flagMaterial: FlagMaterialOptions;
};

type ClothWithOptions = ClothSimulation & {
  setSelfCollisionOptions?: (options: ClothOptions) => void;
};

type ClothConstructorWithOptions = new (
  width: number,
  height: number,
  seed: number,
  resolution: CeremonySettings['meshResolution'],
  options: ClothOptions
) => ClothSimulation;
const ClothSimulationWithOptions = ClothSimulation as unknown as ClothConstructorWithOptions;

const DEFAULT_CLOTH_OPTIONS: ClothOptions = {
  selfCollision: true,
  collisionThickness: 0.2,
  collisionIterations: 2,
};
const DEFAULT_FLAG_MATERIAL_OPTIONS: FlagMaterialOptions = {
  gloss: 0.4,
  metalness: 0.5,
  clearcoat: 0,
  clearcoatGloss: 0,
};

const RANK_FLAG_TOP: Record<1 | 2 | 3, number> = { 1: 5.4, 2: 4.55, 3: 3.8 };
const POLE_BOTTOM = -12;
const FLAG_ROPE_GAP = 0.16;
const FLAG_PALETTE = ['#d75a55', '#3d86b5', '#d2aa56', '#608d76', '#8e659c', '#d07d47'];

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Ceremony markup is incomplete: ${selector}`);
  return element;
}
function flagTop(rank: 1 | 2 | 3): number {
  return RANK_FLAG_TOP[rank] * settings.pole.heightScale;
}
const sceneContainer = requireElement<HTMLElement>('#scene-container');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
sceneContainer.appendChild(renderer.domElement);
const world = new THREE.Group();
scene.add(world);
const clock = new THREE.Clock();
let settings: RendererSettings = cloneSettings(DEFAULT_SETTINGS);
let settingsSignature = '';
let buildToken = 0;
let activeFlags: ActiveFlag[] = [];
let backgroundTexture: THREE.Texture | null = null;
let backgroundVideo: HTMLVideoElement | null = null;
let animationStart = 0;
let animationEnd = 0;
let animationDuration = DEFAULT_SETTINGS.hoistDuration;
let animationStagger = DEFAULT_SETTINGS.stagger;
let backgroundSourceAspect: number | null = null;
let physicsAccumulator = 0;
let animationRunning = false;
let currentRevision = -1;
let currentExecuteId: string | null = null;
let serverClockOffset = 0;
let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let warningMessages = new Set<string>();
let physicsTime = 0;
let stateMotion: 'up' | 'down' = 'up';
const poleParts = new Map<string, THREE.Object3D[]>();
const attachmentRopes = new Map<string, THREE.Group>();

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? THREE.MathUtils.clamp(value, minimum, maximum) : fallback;
}
function cloneSettings(value: CeremonySettings): RendererSettings {
  const cloned = JSON.parse(JSON.stringify(value)) as CeremonySettings & {
    cloth?: Partial<ClothOptions>;
    flagMaterial?: Partial<FlagMaterialOptions>;
  };
  const rawCloth = cloned.cloth;
  const rawMaterial = cloned.flagMaterial;
  return {
    ...cloned,
    cloth: {
      selfCollision: typeof rawCloth?.selfCollision === 'boolean' ? rawCloth.selfCollision : DEFAULT_CLOTH_OPTIONS.selfCollision,
      collisionThickness: clamp(Number(rawCloth?.collisionThickness), 0.01, 0.2, DEFAULT_CLOTH_OPTIONS.collisionThickness),
      collisionIterations: rawCloth?.collisionIterations === 2 ? 2 : DEFAULT_CLOTH_OPTIONS.collisionIterations,
    },
    flagMaterial: {
      gloss: clamp(Number(rawMaterial?.gloss), 0, 1, DEFAULT_FLAG_MATERIAL_OPTIONS.gloss),
      metalness: clamp(Number(rawMaterial?.metalness), 0, 1, DEFAULT_FLAG_MATERIAL_OPTIONS.metalness),
      clearcoat: clamp(Number(rawMaterial?.clearcoat), 0, 1, DEFAULT_FLAG_MATERIAL_OPTIONS.clearcoat),
      clearcoatGloss: clamp(Number(rawMaterial?.clearcoatGloss), 0, 1, DEFAULT_FLAG_MATERIAL_OPTIONS.clearcoatGloss),
    },
  };
}
function normalizeRendererSettings(value: unknown): RendererSettings {
  const normalized = normalizeSettings(value);
  const source = value as { cloth?: Partial<ClothOptions>; flagMaterial?: Partial<FlagMaterialOptions> };
  const merged = {
    ...normalized,
    cloth: source?.cloth ?? settings.cloth,
    flagMaterial: source?.flagMaterial ?? settings.flagMaterial,
  } as CeremonySettings;
  return cloneSettings(merged);
}
function setWarning(message: string): void {
  if (!message || warningMessages.has(message)) return;
  warningMessages.add(message);
  console.warn(message);
}
function countryColor(code: string): THREE.Color {
  let hash = 0; for (let index = 0; index < code.length; index += 1) hash = (hash * 31 + code.charCodeAt(index)) | 0;
  return new THREE.Color(FLAG_PALETTE[Math.abs(hash) % FLAG_PALETTE.length]);
}
function disposeMaterial(material: THREE.Material): void {
  const withMap = material as THREE.Material & { map?: THREE.Texture | null };
  if (withMap.map) withMap.map.dispose(); material.dispose();
}
function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) mesh.material.forEach(disposeMaterial);
    else if (mesh.material) disposeMaterial(mesh.material);
  });
}
function clearWorld(): void {
  while (world.children.length) { const child = world.children.pop(); if (child) disposeObject(child); }
  activeFlags = [];
  poleParts.clear();
  attachmentRopes.clear();
  if (backgroundTexture) { backgroundTexture.dispose(); backgroundTexture = null; }
  if (backgroundVideo) { backgroundVideo.pause(); backgroundVideo.removeAttribute('src'); backgroundVideo.load(); backgroundVideo = null; }
  backgroundSourceAspect = null;
  scene.background = settings.background.type === 'transparent' ? null : new THREE.Color(settings.background.color);
  renderer.setClearAlpha(settings.background.type === 'transparent' ? 0 : 1);
}
function createStandardMaterial(color: string, roughness = 0.58, metalness = 0.08): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color, roughness, metalness }); }
function createFinial(style: FinialStyle, color: string, radius: number, x: number, y: number): THREE.Mesh | null {
  const scaledRadius = radius * settings.pole.finialSize;
  if (scaledRadius <= 0) return null;
  let geometry: THREE.BufferGeometry;
  let offset = 0;
  if (style === 'flat') { geometry = new THREE.CylinderGeometry(scaledRadius * 2.2, scaledRadius * 2.2, 0.075, 24); offset = 0.04; }
  else if (style === 'spear') { geometry = new THREE.ConeGeometry(scaledRadius * 2.25, 0.38 * settings.pole.finialSize, 4); offset = 0.19 * settings.pole.finialSize; }
  else { geometry = new THREE.SphereGeometry(scaledRadius * 2.55, 20, 14); offset = scaledRadius * 2.55; }
  const roughness = THREE.MathUtils.lerp(0.95, 0.06, settings.pole.gloss);
  const finial = new THREE.Mesh(geometry, createStandardMaterial(color, roughness, settings.pole.gloss));
  finial.position.set(x, y + offset, 0);
  finial.castShadow = settings.lighting.shadowsEnabled;
  world.add(finial);
  return finial;
}
function flagRasterSize(): { width: number; height: number } {
  const requestedWidth = settings.meshResolution === 'ultra' ? 2048 : settings.meshResolution === 'high' ? 1536 : 1024;
  const maxTextureSize = Math.max(1, renderer.capabilities.maxTextureSize);
  const width = Math.min(requestedWidth, maxTextureSize);
  return { width, height: Math.min(maxTextureSize, Math.max(1, Math.round(width * 0.75))) };
}
function updateFlagMaterial(material: THREE.MeshPhysicalMaterial): void {
  const materialSettings = settings.flagMaterial;
  material.roughness = THREE.MathUtils.lerp(0.95, 0.05, materialSettings.gloss);
  material.metalness = materialSettings.metalness;
  material.clearcoat = materialSettings.clearcoat;
  material.clearcoatRoughness = 1 - materialSettings.clearcoatGloss;
  material.needsUpdate = true;
}
function updateFlagMaterials(): void {
  activeFlags.forEach((flag) => updateFlagMaterial(flag.material));
}
function configureCloth(cloth: ClothSimulation): void {
  const configurableCloth = cloth as ClothWithOptions;
  if (typeof configurableCloth.setSelfCollisionOptions === 'function') configurableCloth.setSelfCollisionOptions(settings.cloth);
}
function loadFlagTexture(flag: ActiveFlag, token: number): void {
  const resolved = resolveFlag(flag.slot, settings.customFlags);
  const source = resolved.imageUrl;
  if (!source) {
    flag.material.map?.dispose();
    flag.material.map = null;
    flag.material.color.set('#ffffff');
    flag.material.needsUpdate = true;
    if (token === buildToken) setWarning(`Flag image not supplied: ${resolved.name}`);
    return;
  }
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    const canvas = document.createElement('canvas');
    const rasterSize = flagRasterSize();
    canvas.width = rasterSize.width;
    canvas.height = rasterSize.height;
    const context = canvas.getContext('2d');
    if (!context) {
      if (token === buildToken) setWarning(`Flag asset could not be processed: ${flag.slot.countryCode.toUpperCase()}`);
      return;
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    if (token !== buildToken) {
      texture.dispose();
      return;
    }
    flag.material.map?.dispose();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    flag.material.map = texture;
    flag.material.color.set('#ffffff');
    flag.material.needsUpdate = true;
  };
  image.onerror = () => {
    if (token === buildToken) setWarning(`Flag asset missing: ${resolved.name}`);
  };
  image.src = source;
}
function hashString(value: string): number { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); } return hash >>> 0; }
function createFlag(slot: CeremonySlot, x: number, index: number, token: number): void {
  const width = Math.max(0.5, settings.flagWidth);
  const height = Math.max(0.35, settings.flagHeight);
  const cloth = new ClothSimulationWithOptions(width, height, hashString(slot.id) % 2, settings.meshResolution, settings.cloth);
  configureCloth(cloth);
  const placeholder = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  placeholder.needsUpdate = true;
  const material = new THREE.MeshPhysicalMaterial({ color: countryColor(slot.countryCode), map: placeholder, side: THREE.DoubleSide });
  updateFlagMaterial(material);
  const mesh = new THREE.Mesh(cloth.geometry, material);
  mesh.position.set(x + FLAG_ROPE_GAP, flagTop(slot.rank), 0);
  mesh.castShadow = settings.lighting.shadowsEnabled;
  mesh.receiveShadow = settings.lighting.shadowsEnabled;
  world.add(mesh);
  const phase = ((hashString(slot.id) % 1000) / 1000) * Math.PI * 2 + index * 0.37;
  mesh.rotation.y = THREE.MathUtils.degToRad(-14 + Math.sin(phase) * 5);
  const flag: ActiveFlag = { slot, mesh, material, cloth, phase, hoist: 1, hoistFrom: 1, hoistTarget: 1, hoistStartAt: 0, hoistDurationMs: 0, hidden: false };
  activeFlags.push(flag);
  loadFlagTexture(flag, token);
}
function createPole(slot: CeremonySlot, x: number): void {
  if (!settings.pole.visible) { poleParts.set(slot.id, []); return; }
  const radius = Math.max(0.018, settings.pole.thickness / 2);
  const top = flagTop(slot.rank);
  const poleHeight = top - POLE_BOTTOM;
  const roughness = THREE.MathUtils.lerp(0.95, 0.05, settings.pole.gloss);
  const material = createStandardMaterial(settings.pole.color, roughness, THREE.MathUtils.lerp(0.25, 1, settings.pole.gloss));
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.08, poleHeight, 20), material);
  pole.position.set(x, POLE_BOTTOM + poleHeight / 2, 0);
  pole.castShadow = settings.lighting.shadowsEnabled;
  pole.receiveShadow = settings.lighting.shadowsEnabled;
  world.add(pole);
  const finial = createFinial(settings.pole.finialStyle, settings.pole.finialColor, radius, x, top);
  const ropes = createAttachmentRopes(radius, top);
  ropes.position.x = x;
  world.add(ropes);
  attachmentRopes.set(slot.id, ropes);
  poleParts.set(slot.id, finial ? [pole, finial, ropes] : [pole, ropes]);
}
function createAttachmentRopes(poleRadius: number, top: number): THREE.Group {
  const group = new THREE.Group();
  const flagBottom = top - settings.flagHeight;
  const ropeStart = poleRadius + 0.012;
  const ropeEnd = FLAG_ROPE_GAP;
  const tieLength = Math.max(0.02, ropeEnd - ropeStart);
  const material = new THREE.MeshStandardMaterial({ color: '#e5e1d5', roughness: 0.9, metalness: 0 });
  const tieGeometry = new THREE.CylinderGeometry(0.009, 0.009, tieLength, 8);
  for (const y of [top, flagBottom]) {
    const tie = new THREE.Mesh(tieGeometry, material);
    tie.rotation.z = -Math.PI / 2;
    tie.position.set((ropeStart + ropeEnd) / 2, y, 0);
    group.add(tie);
    const eyelet = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.006, 8, 16), createStandardMaterial('#c7ccd0', 0.32, 0.75));
    eyelet.position.set(ropeEnd, y, 0.006);
    group.add(eyelet);
  }
  const halyardLength = Math.max(0.05, top - flagBottom);
  const halyard = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, halyardLength, 8), material);
  halyard.position.set(ropeStart, (top + flagBottom) / 2, 0);
  group.add(halyard);
  return group;
}
function setupLights(): void {
  const lighting = settings.lighting;
  renderer.shadowMap.enabled = lighting.shadowsEnabled;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  world.add(new THREE.HemisphereLight('#dcecff', '#08192a', 0.85));
  const key = new THREE.DirectionalLight(lighting.sunColor, lighting.sunIntensity);
  const azimuth = THREE.MathUtils.degToRad(lighting.sunAzimuth);
  const elevation = THREE.MathUtils.degToRad(lighting.sunElevation);
  const radius = 18;
  key.position.set(
    Math.cos(elevation) * Math.sin(azimuth) * radius,
    Math.sin(elevation) * radius,
    Math.cos(elevation) * Math.cos(azimuth) * radius
  );
  key.castShadow = lighting.shadowsEnabled;
  const shadowSize = lighting.shadowQuality === 'high' ? 2048 : lighting.shadowQuality === 'medium' ? 1024 : 512;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  key.shadow.radius = 1 + lighting.shadowSoftness * 12;
  key.shadow.bias = -0.00035;
  key.shadow.camera.left = -20;
  key.shadow.camera.right = 20;
  key.shadow.camera.top = 15;
  key.shadow.camera.bottom = -15;
  world.add(key);
  if (lighting.shadowsEnabled && settings.background.type !== 'transparent') {
    const catcher = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 40),
      new THREE.ShadowMaterial({ color: '#000000', opacity: 0.28 })
    );
    catcher.position.set(0, 3, -2.5);
    catcher.receiveShadow = true;
    world.add(catcher);
  }
}
function rebuild(settingsValue: CeremonySettings): void {
  const previousHoists = new Map(activeFlags.map((flag) => [flag.slot.id, flag.hoist]));
  const previousCloth = new Map(activeFlags.map((flag) => [flag.slot.id, flag.cloth.snapshot()]));
  const wasAnimating = animationRunning;
  settings = cloneSettings(settingsValue); settingsSignature = JSON.stringify(settings); buildToken += 1; const token = buildToken; warningMessages = new Set<string>(); clearWorld(); setupLights();
  const count = Math.max(1, settings.slots.length); const spacing = settings.mastSpacing;
  const positions = settings.slots.map((slot, index) => index * spacing - ((count - 1) * spacing) / 2 + slot.xOffset);
  settings.slots.forEach((slot, index) => { const x = positions[index]; createPole(slot, x); createFlag(slot, x, index, token); });
  const minX = Math.min(...positions, 0) - settings.flagWidth * 0.15;
  const maxX = Math.max(...positions, 0) + settings.flagWidth;
  updateCamera(minX, maxX, count); loadBackground(token); animationRunning = wasAnimating; activeFlags.forEach((flag) => {
    flag.hoist = previousHoists.get(flag.slot.id) ?? (stateMotion === 'down' ? 0 : 1);
    flag.hoistFrom = flag.hoist;
    flag.hoistTarget = flag.hoist;
    setFlagPosition(flag);
    const snapshot = previousCloth.get(flag.slot.id);
    if (snapshot) flag.cloth.restore(snapshot);
  });
}
function updateCamera(minX: number, maxX: number, count: number): void {
  const fovRadians = THREE.MathUtils.degToRad(camera.fov);
  const horizontalDistance = (Math.max(maxX - minX, 8) / 2) / Math.tan(fovRadians / 2);
  const highestPoint = flagTop(1) + settings.pole.finialSize * 0.45;
  const visibleBottom = -0.7;
  const targetY = (highestPoint + visibleBottom) / 2;
  const verticalDistance = ((highestPoint - visibleBottom) / 2) / Math.tan(fovRadians / 2);
  const targetX = (minX + maxX) / 2;
  camera.position.set(targetX + 2.8, targetY + (count > 4 ? 0.35 : 0.2), Math.max(10.5, horizontalDistance * 1.08, verticalDistance * 1.08));
  camera.lookAt(targetX, targetY, 0);
  camera.updateProjectionMatrix();
  resize();
  activeFlags.forEach((flag) => {
    if (flag.hoist <= 0) setFlagPosition(flag);
  });
}
function getFrustumBottom(): number {
  camera.updateMatrixWorld();
  const near = new THREE.Vector3(0, -1, -1).unproject(camera);
  const far = new THREE.Vector3(0, -1, 1).unproject(camera);
  const direction = far.sub(near);
  const denominator = direction.z;
  if (Math.abs(denominator) < 1e-6) return -1;
  const distance = -near.z / denominator;
  return near.y + direction.y * distance;
}
function getLoweredFlagY(): number {
  const safetyMargin = Math.max(0.35, settings.flagHeight * 0.2);
  return getFrustumBottom() - safetyMargin;
}
function setFlagPosition(flag: ActiveFlag): void {
  const raisedY = flagTop(flag.slot.rank);
  const loweredY = getLoweredFlagY();
  flag.mesh.position.y = THREE.MathUtils.lerp(loweredY, raisedY, flag.hoist);
  const ropes = attachmentRopes.get(flag.slot.id);
  if (ropes) ropes.position.y = flag.mesh.position.y - raisedY;
  updateFlagVisibility(flag);
}
function updateFlagVisibility(flag: ActiveFlag): void {
  if (flag.hoist > 0) {
    flag.hidden = false;
    flag.mesh.visible = true;
    const ropes = attachmentRopes.get(flag.slot.id);
    if (ropes) ropes.visible = true;
    return;
  }
  flag.mesh.geometry.computeBoundingBox();
  const maxLocalY = flag.mesh.geometry.boundingBox?.max.y ?? 0;
  const fullyBelow = flag.mesh.position.y + maxLocalY < getFrustumBottom() - 0.02;
  flag.hidden = fullyBelow;
  flag.mesh.visible = !fullyBelow;
  const ropes = attachmentRopes.get(flag.slot.id);
  if (ropes) ropes.visible = !fullyBelow;
}
function fitBackgroundTexture(): void {
  if (!backgroundTexture || !backgroundSourceAspect) return;
  const viewportAspect = Math.max(1, sceneContainer.clientWidth) / Math.max(1, sceneContainer.clientHeight);
  backgroundTexture.repeat.set(1, 1);
  backgroundTexture.offset.set(0, 0);
  if (backgroundSourceAspect > viewportAspect) {
    backgroundTexture.repeat.x = viewportAspect / backgroundSourceAspect;
    backgroundTexture.offset.x = (1 - backgroundTexture.repeat.x) / 2;
  } else {
    backgroundTexture.repeat.y = backgroundSourceAspect / viewportAspect;
    backgroundTexture.offset.y = (1 - backgroundTexture.repeat.y) / 2;
  }
  backgroundTexture.updateMatrix();
}
function loadBackground(token: number): void {
  if (backgroundTexture) { backgroundTexture.dispose(); backgroundTexture = null; }
  if (backgroundVideo) { backgroundVideo.pause(); backgroundVideo.removeAttribute('src'); backgroundVideo.load(); backgroundVideo = null; }
  backgroundSourceAspect = null;
  const background = settings.background;
  renderer.setClearAlpha(background.type === 'transparent' ? 0 : 1);
  if (background.type === 'transparent') {
    scene.background = null;
    return;
  }
  scene.background = new THREE.Color(background.color);
  if (!background.url || background.type === 'color') return;
  if (background.type === 'image') {
    new THREE.TextureLoader().load(background.url, (texture) => {
      if (token !== buildToken) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      backgroundTexture = texture;
      const image = texture.image as HTMLImageElement;
      backgroundSourceAspect = (image.naturalWidth || image.width) / Math.max(1, image.naturalHeight || image.height);
      fitBackgroundTexture();
      scene.background = texture;
    }, undefined, () => { if (token === buildToken) setWarning('Background image could not be loaded.'); });
    return;
  }
  const video = document.createElement('video');
  video.src = background.url;
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  backgroundVideo = video;
  video.addEventListener('canplay', () => {
    if (token !== buildToken) return;
    backgroundTexture = new THREE.VideoTexture(video);
    backgroundTexture.colorSpace = THREE.SRGBColorSpace;
    backgroundTexture.minFilter = THREE.LinearFilter;
    backgroundTexture.magFilter = THREE.LinearFilter;
    backgroundTexture.wrapS = THREE.ClampToEdgeWrapping;
    backgroundTexture.wrapT = THREE.ClampToEdgeWrapping;
    backgroundSourceAspect = video.videoWidth / Math.max(1, video.videoHeight);
    fitBackgroundTexture();
    scene.background = backgroundTexture;
    void video.play().catch(() => setWarning('Background video is waiting for interaction.'));
  }, { once: true });
  video.addEventListener('error', () => { if (token === buildToken) setWarning('Background video could not be loaded.'); }, { once: true });
  video.load();
}
function scheduleHoist(state: CeremonyState): void {
  const now = Date.now();
  stateMotion = state.motion === 'down' ? 'down' : 'up';
  animationStart = state.executeAt && Number.isFinite(state.executeAt) ? state.executeAt - serverClockOffset : now;
  animationDuration = Math.max(0.1, state.executeDuration);
  animationStagger = Math.max(0, state.executeStagger);
  const lastRankOffset = activeFlags.reduce((maximum, flag) => Math.max(maximum, flag.slot.rank - 1), 0);
  animationEnd = state.executeEndAt && Number.isFinite(state.executeEndAt)
    ? state.executeEndAt - serverClockOffset
    : animationStart + animationStagger * 1000 * lastRankOffset + animationDuration * 1000;
  animationRunning = true;
  physicsAccumulator = 0;
  const down = stateMotion === 'down';
  activeFlags.forEach((flag) => {
    const rankDelay = down ? 0 : (flag.slot.rank - 1) * animationStagger * 1000;
    flag.hoistFrom = flag.hoist;
    flag.hoistTarget = down ? 0 : 1;
    flag.hoistStartAt = animationStart + rankDelay;
    flag.hoistDurationMs = Math.max(100, animationDuration * 1000);
    if (!down) {
      // A hidden flag must be made visible at its current position before it
      // begins to rise. Its cloth particles are deliberately left untouched.
      flag.hidden = false;
      flag.mesh.visible = true;
    }
    setFlagPosition(flag);
  });
}
function animate(): void {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  const now = Date.now();
  for (const flag of activeFlags) {
    if (animationRunning) {
      const progress = THREE.MathUtils.clamp((now - flag.hoistStartAt) / flag.hoistDurationMs, 0, 1);
      const eased = progress * progress * (3 - 2 * progress);
      flag.hoist = THREE.MathUtils.lerp(flag.hoistFrom, flag.hoistTarget, eased);
      setFlagPosition(flag);
    }
  }
  if (animationRunning && now >= animationEnd) {
    animationRunning = false;
    for (const flag of activeFlags) {
      flag.hoist = flag.hoistTarget;
      flag.hoistFrom = flag.hoist;
      setFlagPosition(flag);
    }
  }
  physicsAccumulator = Math.min(physicsAccumulator + delta, 0.05);
  while (physicsAccumulator >= 1 / 60) {
    for (const flag of activeFlags) {
      if (flag.hidden) continue;
      // Keep the flag slack until the configured height, then smoothly ramp
      // wind and outward tension together so nothing moves prematurely.
      const pickup = windPickup(flag.hoist);
      if (pickup === 0) flag.cloth.dampenMotion();
      flag.cloth.simulate({
        strength: settings.windStrength * pickup,
        direction: settings.windDirection,
        gustiness: settings.windGustiness * pickup,
        turbulence: settings.windTurbulence * pickup,
        unfurl: settings.windStrength * pickup,
        phase: flag.phase,
        time: physicsTime
      });
    }
    physicsTime += 1 / 60;
    physicsAccumulator -= 1 / 60;
  }
  renderer.render(scene, camera);
}
function windPickup(hoist: number): number {
  const threshold = THREE.MathUtils.clamp(settings.windStartPercent / 100, 0, 1);
  if (hoist < threshold) return 0;
  if (threshold >= 0.999) return hoist >= 1 ? 1 : 0;
  return THREE.MathUtils.smoothstep(hoist, threshold, Math.min(1, threshold + 0.12));
}
function resize(): void {
  const width = sceneContainer.clientWidth || window.innerWidth;
  const height = sceneContainer.clientHeight || window.innerHeight;
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  fitBackgroundTexture();
  activeFlags.forEach((flag) => {
    if (flag.hoist <= 0) setFlagPosition(flag);
  });
}
function topologySignature(value: CeremonySettings): string {
  return JSON.stringify({ width: value.flagWidth, height: value.flagHeight, resolution: value.meshResolution, slots: value.slots.map((slot) => [slot.id, slot.rank]) });
}
function slotTextureKey(slot: CeremonySlot, value: CeremonySettings): string {
  return resolveFlag(slot, value.customFlags).imageUrl ?? `missing:${slot.flagId ?? slot.countryCode}`;
}
function updateTransforms(value: CeremonySettings): void {
  const count = Math.max(1, value.slots.length);
  const spacing = value.mastSpacing;
  const positions = value.slots.map((slot, index) => index * spacing - ((count - 1) * spacing) / 2 + slot.xOffset);
  const byId = new Map(value.slots.map((slot, index) => [slot.id, { slot, x: positions[index] }]));
  activeFlags.forEach((flag) => {
    const item = byId.get(flag.slot.id);
    if (!item) return;
    flag.slot = item.slot;
    flag.mesh.position.x = item.x + FLAG_ROPE_GAP;
    setFlagPosition(flag);
    poleParts.get(item.slot.id)?.forEach((part) => { part.position.x = item.x; });
  });
  updateCamera(Math.min(...positions, 0) - value.flagWidth * 0.15, Math.max(...positions, 0) + value.flagWidth, count);
}
function applyLiveSettings(previous: CeremonySettings, next: CeremonySettings): void {
  // Keep the active cloth and physics clock alive for wind/timing and layout
  // changes. Only the cheap scene transforms and texture references are updated.
  settings = cloneSettings(next);
  updateTransforms(settings);
  activeFlags.forEach((flag) => configureCloth(flag.cloth));
  updateFlagMaterials();
  const previousFlags = new Map(previous.slots.map((slot) => [slot.id, slot]));
  for (const flag of activeFlags) {
    const oldSlot = previousFlags.get(flag.slot.id);
    if (!oldSlot || slotTextureKey(oldSlot, previous) !== slotTextureKey(flag.slot, settings)) loadFlagTexture(flag, buildToken);
  }
  if (previous.background.type !== settings.background.type || previous.background.color !== settings.background.color || previous.background.url !== settings.background.url) {
    loadBackground(buildToken);
  }
  settingsSignature = JSON.stringify(settings);
}
function applyState(state: CeremonyState): boolean {
  // Normalize every incoming payload at the rendering boundary. This keeps a
  // freshly-built client compatible with an older server process that may
  // still send the pre-v2 shape (without customFlags, mastSpacing, etc.).
  const normalizedSettings = normalizeRendererSettings(state.settings);
  const normalizedSignature = JSON.stringify(normalizedSettings);
  const changed = state.revision !== currentRevision || settingsSignature !== normalizedSignature;
  if (!changed) return false;
  const needsTopology = activeFlags.length === 0 || topologySignature(settings) !== topologySignature(normalizedSettings);
  const needsSceneRebuild = needsTopology || JSON.stringify(settings.pole) !== JSON.stringify(normalizedSettings.pole) || JSON.stringify(settings.lighting) !== JSON.stringify(normalizedSettings.lighting);
  const previous = settings;
  if (needsSceneRebuild) rebuild(normalizedSettings);
  else applyLiveSettings(previous, normalizedSettings);
  currentRevision = state.revision;
  return needsSceneRebuild;
}
function processServerMessage(message: ServerMessage): void {
  const state = message.state;
  if (Number.isFinite(state.serverTime)) serverClockOffset = state.serverTime - Date.now();
  // Use the terminal server motion before rebuilding after a reload.
  stateMotion = state.motion === 'down' ? 'down' : 'up';
  const previousExecuteId = currentExecuteId;
  const rebuilt = applyState(state);
  currentExecuteId = state.lastExecuteId;
  const serverNow = Date.now() + serverClockOffset;
  const executionIsActive = Boolean(state.lastExecuteId && state.executeAt && state.executeEndAt && serverNow < state.executeEndAt);
  const newExecution = previousExecuteId !== state.lastExecuteId || message.type === 'executed';
  if (executionIsActive && (newExecution || (!animationRunning && rebuilt))) {
    scheduleHoist(state);
    return;
  }
}
function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket.addEventListener('open', () => { socket?.send(JSON.stringify({ type: 'hello', role: 'ceremony' })); });
  socket.addEventListener('message', (event) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerMessage;
    } catch (error) {
      console.error('Control sent invalid JSON.', error);
      setWarning('Invalid message received from control.');
      return;
    }
    if (!message || (message.type !== 'state' && message.type !== 'executed')) return;
    try {
      processServerMessage(message);
    } catch (error) {
      console.error('Control message could not be applied.', error, message);
      setWarning('Control settings could not be applied.');
    }
  });
  socket.addEventListener('close', () => { socket = null; if (reconnectTimer === undefined) reconnectTimer = window.setTimeout(() => { reconnectTimer = undefined; connect(); }, 2500); });
}
sceneContainer.addEventListener('dblclick', () => {
  if (!document.fullscreenElement) void sceneContainer.requestFullscreen().catch(() => setWarning('Fullscreen is not available.'));
});
document.addEventListener('fullscreenchange', resize);
window.addEventListener('resize', resize);
resize(); animate(); connect();
