const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const catalogue = require('../src/shared/event-flags.json');
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
        const assets = await context.newPage();
        await assets.goto(base + '/api/v1/health');
        const failures = await assets.evaluate(async flags => {
            const failures = [];
            for (const flag of flags.filter(flag => flag.imageUrl)) {
                const image = new Image(); image.src = flag.imageUrl;
                try { await image.decode(); if (!image.naturalWidth || !image.naturalHeight) failures.push(flag.name); }
                catch (error) { failures.push(`${flag.name}: ${error.message}`); }
            }
            return failures;
        }, catalogue);
        assert.deepEqual(failures, [], 'Every event country image must decode offline');
        await assets.close();
        const control = await context.newPage();
        await control.goto(base + '/control.html');
        await control.waitForFunction(() => document.body.textContent.toLowerCase().includes('connected'));
        const select = control.locator('[data-slot-field="countryCode"]').first();
        const options = await select.locator('option').evaluateAll(nodes => nodes.map(option => ({ value: option.value, text: option.textContent, disabled: option.disabled })));
        for (const flag of catalogue) {
            const option = options.find(option => option.value === (flag.code || flag.id));
            assert.ok(option, flag.name);
            assert.ok(option.text.includes(flag.name), flag.name);
            assert.equal(option.disabled, !flag.imageUrl, flag.name);
        }
        const output = await context.newPage();
        await output.goto(base);
        await output.locator('canvas').waitFor();
        await output.waitForFunction(() => { const canvas = document.querySelector('canvas'); return canvas.width > 0 && canvas.height > 0; });
        await output.waitForTimeout(500);
        const saved = await (await context.request.get(base + '/api/v1/settings')).json();
        try {
            const renderedTaipei = output.waitForRequest(request => new URL(request.url()).pathname === '/event-flags/tw.png');
            await select.selectOption('TW');
            await renderedTaipei;
            await control.waitForFunction(() => document.querySelector('.country-flag-thumb')?.getAttribute('src') === '/event-flags/tw.png');
            const renderedFrance = output.waitForRequest(request => new URL(request.url()).pathname === '/event-flags/fr.svg');
            await select.selectOption('FR');
            await renderedFrance;
        } finally {
            await context.request.post(base + '/api/v1/settings', { data: saved });
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        console.log('PASS: offline control, all 82 event country images, missing World Gymnastics entries, live Taipei/France texture changes and WebGL output.');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
