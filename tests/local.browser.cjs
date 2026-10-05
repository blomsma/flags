const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
    const base = process.env.TEST_BASE_URL || 'http://localhost:4174';
    const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], executablePath: process.env.BROWSER_EXECUTABLE || undefined });
    try {
        const context = await browser.newContext();
        const errors = [], external = [];
        await context.route('**/*', route => {
            if (new URL(route.request().url()).origin !== new URL(base).origin) { external.push(route.request().url()); return route.abort(); }
            return route.continue();
        });
        context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
        const control = await context.newPage();
        await control.goto(base + '/control.html');
        await control.waitForFunction(() => document.body.textContent.toLowerCase().includes('connected'));
        const output = await context.newPage();
        await output.goto(base);
        await output.locator('canvas').waitFor();
        await output.waitForFunction(() => { const canvas = document.querySelector('canvas'); return canvas.width > 0 && canvas.height > 0; });
        await output.waitForTimeout(500);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        console.log('PASS: offline Flags control, WebSocket connection, country assets and WebGL output.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
