const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { once } = require('node:events');

test('settings, custom uploads and show control work after a clean restart', async t => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), 'flags-test-'));
    const reservation = net.createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let child;
    let logs = '';
    async function start() {
        child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATA_DIR: data, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
        for (let i = 0; i < 100; i++) {
            try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) return; } catch {}
            if (child.exitCode !== null) throw new Error(logs);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Server did not start: ' + logs);
    }
    async function stop() { if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
    t.after(async () => { await stop(); await fs.rm(data, { recursive: true, force: true }); });
    await start();
    const url = `http://127.0.0.1:${port}`;
    const settings = await (await fetch(`${url}/api/v1/settings`)).json();
    const changed = await fetch(`${url}/api/v1/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windStrength: .73, background: { color: '#123456' } }) });
    assert.equal(changed.status, 200);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
    const upload = await fetch(`${url}/api/v1/flags`, { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Flag-Name': 'Event' }, body: png });
    assert.equal(upload.status, 201);
    const custom = await upload.json();
    await fetch(`${url}/api/v1/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customFlags: [custom] }) });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const snapshot = await new Promise((resolve, reject) => { ws.onmessage = e => resolve(JSON.parse(e.data)); ws.onerror = reject; });
    assert.equal(snapshot.state.settings.windStrength, .73);
    const executed = new Promise(resolve => { ws.onmessage = e => { const message = JSON.parse(e.data); if (message.type === 'executed') resolve(message); }; });
    assert.equal((await fetch(`${url}/api/v1/hoist/up`, { method: 'POST' })).status, 202);
    assert.equal((await executed).state.motion, 'up');
    ws.close();
    await stop(); await start();
    const persisted = await (await fetch(`${url}/api/v1/state`)).json();
    assert.equal(persisted.settings.windStrength, .73);
    assert.equal(persisted.settings.background.color, '#123456');
    assert.equal(persisted.settings.background.type, settings.background.type);
    assert.equal(persisted.settings.customFlags[0].imageUrl, custom.imageUrl);
    assert.notEqual(persisted.revision, 0);
    assert.equal(persisted.motion, 'idle');
    assert.deepEqual(Buffer.from(await (await fetch(url + custom.imageUrl)).arrayBuffer()), png);
    assert.equal((await fetch(`${url}/flags/4x3/nl.svg`)).status, 200);
});
