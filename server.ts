import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_SETTINGS, normalizeSettings, type CeremonySettings, type CeremonyState, type ClientMessage, type ServerMessage } from './src/shared/types.ts';

const HOST = '0.0.0.0'; const PORT = Number(process.env.PORT) || 4174; const LEAD = 500; const MAX = 256 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url)); const dist = path.join(here, 'dist'); const flags = path.join(here, 'node_modules', 'flag-icons', 'flags'); const data = path.resolve(process.env.DATA_DIR || path.join(here, 'data')); const media = path.join(data, 'backgrounds');
const allowedImages: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const app = express(); app.disable('x-powered-by');
let state: CeremonyState = { settings: normalizeSettings(DEFAULT_SETTINGS), revision: 0, lastExecuteId: null, executeAt: null, executeEndAt: null, executeDuration: 0, executeStagger: 0, serverTime: Date.now(), motion: 'idle' };
mkdirSync(data, { recursive: true });
const seed = path.join(here, 'seed');
if (existsSync(seed)) cpSync(seed, data, { recursive: true, force: false, errorOnExist: false });
const settingsFile = path.join(data, 'settings.json');
try { state.settings = normalizeSettings(JSON.parse(readFileSync(settingsFile, 'utf8'))); state.revision = 1; }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
function saveSettings(settings: CeremonySettings): void {
  const tmp = settingsFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(settings, null, 2), { flush: true });
  renameSync(tmp, settingsFile);
}
const webSockets = new WebSocketServer({ noServer: true });
const snapshot = (): CeremonyState => ({ ...state, settings: normalizeSettings(state.settings), serverTime: Date.now() });
const send = (socket: WebSocket, message: ServerMessage): void => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const broadcast = (type: 'state' | 'executed' = 'state'): void => { const payload = JSON.stringify({ type, state: snapshot() }); webSockets.clients.forEach((s) => { if (s.readyState === WebSocket.OPEN) s.send(payload); }); };
function updateSettings(value: unknown): void { const settings = normalizeSettings(value); saveSettings(settings); state = { ...state, settings, revision: state.revision + 1, serverTime: Date.now() }; broadcast(); }
function mergeSettings(patch: unknown): CeremonySettings { const base = state.settings as unknown as Record<string, unknown>; const incoming = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>; const merged: Record<string, unknown> = { ...base, ...incoming }; for (const key of ['cloth', 'flagMaterial', 'pole', 'lighting', 'background']) { const current = base[key]; const update = incoming[key]; if (current && typeof current === 'object' && update && typeof update === 'object') merged[key] = { ...(current as object), ...(update as object) }; } return normalizeSettings(merged); }
function schedule(direction: 'up' | 'down', settings = state.settings, executeId: string = randomUUID()): void {
  saveSettings(normalizeSettings(settings));
  const start = Date.now() + LEAD; const duration = Math.max(.1, settings.hoistDuration); const last = direction === 'down' ? 0 : settings.slots.reduce((m, s) => Math.max(m, s.rank - 1), 0); const stagger = direction === 'down' ? 0 : settings.stagger;
  state = { ...state, settings: normalizeSettings(settings), revision: state.revision + 1, lastExecuteId: executeId, executeAt: start, executeEndAt: start + (duration + stagger * last) * 1000, executeDuration: duration, executeStagger: stagger, serverTime: Date.now(), motion: direction };
  broadcast('executed');
}
function authorized(req: express.Request): boolean { const token = process.env.API_TOKEN; return !token || req.header('authorization') === `Bearer ${token}` || req.header('x-api-token') === token; }
function mutationAuth(req: express.Request, res: express.Response, next: express.NextFunction): void { if (!authorized(req)) { res.status(401).json({ error: 'API token required' }); return; } next(); }
function parseJson(raw: unknown): unknown { if (typeof raw !== 'string') return raw; try { return JSON.parse(raw); } catch { return null; } }

app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'flag-ceremony', revision: state.revision, serverTime: Date.now() }));
app.get('/api/v1/state', (_req, res) => res.json(snapshot()));
app.get('/api/v1/settings', (_req, res) => res.json(snapshot().settings));
app.use('/media', express.static(media, { immutable: true, maxAge: '1y' })); app.use('/flags', express.static(flags, { immutable: true, maxAge: '1d' }));
app.post('/api/v1/settings', express.json({ limit: '512kb' }), mutationAuth, (req, res) => { updateSettings(mergeSettings(req.body)); res.json(snapshot()); });
app.post(['/api/v1/hoist/up', '/api/v1/flags/up'], mutationAuth, (_req, res) => { schedule('up'); res.status(202).json(snapshot()); });
app.post(['/api/v1/hoist/down', '/api/v1/flags/down'], mutationAuth, (_req, res) => { schedule('down'); res.status(202).json(snapshot()); });
app.post('/api/v1/execute', express.json({ limit: '512kb' }), mutationAuth, (req, res) => { const body = req.body ?? {}; schedule('up', normalizeSettings(body.settings ?? state.settings), typeof body.executeId === 'string' ? body.executeId.slice(0, 128) : randomUUID()); res.json(snapshot()); });
app.post('/api/v1/background', express.raw({ type: Object.keys({ ...allowedImages, 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' }), limit: '250mb' }), mutationAuth, async (req, res) => { const mime = String(req.header('content-type') ?? '').split(';')[0]; const ext = ({ ...allowedImages, 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' } as Record<string, string>)[mime]; if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) { res.status(415).json({ error: 'Invalid media format' }); return; } await mkdir(media, { recursive: true }); const filename = `${Date.now()}-${randomUUID()}.${ext}`; await writeFile(path.join(media, filename), req.body); res.status(201).json({ url: `/media/${filename}`, type: mime.startsWith('video/') ? 'video' : 'image' }); });
function validImage(buffer: Buffer, mime: string): boolean { if (mime === 'image/png') return buffer.length > 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); if (mime === 'image/jpeg') return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9; if (mime === 'image/webp') return buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'; return false; }
app.post('/api/v1/flags', express.raw({ type: Object.keys(allowedImages), limit: '20mb' }), mutationAuth, async (req, res) => { const mime = String(req.header('content-type') ?? '').split(';')[0]; const ext = allowedImages[mime]; const name = String(req.header('x-flag-name') ?? 'Custom flag').trim().slice(0, 120); if (!ext || !Buffer.isBuffer(req.body) || !req.body.length || !validImage(req.body, mime)) { res.status(415).json({ error: 'Use a valid PNG, JPEG or WebP file' }); return; } await mkdir(media, { recursive: true }); const id = `flag-${randomUUID()}`; const filename = `${id}.${ext}`; await writeFile(path.join(media, filename), req.body); res.status(201).json({ id, name: name || id, imageUrl: `/media/${filename}` }); });
app.patch('/api/v1/flags/:id', express.raw({ type: Object.keys(allowedImages), limit: '20mb' }), mutationAuth, async (req, res) => { const id = String(req.params.id); const existing = state.settings.customFlags.find((flag) => flag.id === id); if (!existing) { res.status(404).json({ error: 'Flag not found' }); return; } const mime = String(req.header('content-type') ?? '').split(';')[0]; const ext = allowedImages[mime]; if (!ext || !Buffer.isBuffer(req.body) || !req.body.length || !validImage(req.body, mime)) { res.status(415).json({ error: 'Use a valid PNG, JPEG or WebP file' }); return; } await mkdir(media, { recursive: true }); const filename = `${id}-${Date.now()}.${ext}`; await writeFile(path.join(media, filename), req.body); res.status(200).json({ id, name: existing.name, imageUrl: `/media/${filename}` }); });
app.use('/docs', express.static(path.join(here, 'docs'), { extensions: ['md'] }));
app.use(express.static(dist)); app.use((req, res, next) => { if (req.method === 'GET' && req.headers.accept?.includes('text/html')) { res.sendFile(path.join(dist, req.path === '/control' ? 'control.html' : 'index.html')); return; } next(); });

webSockets.on('connection', (socket) => { send(socket, { type: 'state', state: snapshot() }); socket.on('message', (data) => { if (Buffer.byteLength(data.toString()) > MAX) return; try { const message = JSON.parse(data.toString()) as ClientMessage; if (message.type === 'update') updateSettings(message.settings); else if (message.type === 'execute') schedule('up', message.settings, message.executeId); else if (message.type === 'hoist') schedule(message.direction); } catch { /* malformed client input is ignored */ } }); });
const http = createServer(app); http.on('upgrade', (req, socket, head) => { if (req.url !== '/ws') { socket.destroy(); return; } webSockets.handleUpgrade(req, socket, head, (ws) => webSockets.emit('connection', ws, req)); });
http.listen(PORT, HOST, () => console.log(`Flag ceremony listening on http://${HOST}:${PORT}`));
