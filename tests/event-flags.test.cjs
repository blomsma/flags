const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const catalogue = require('../src/shared/event-flags.json');

test('event selection includes 82 countries and explicitly missing World Gymnastics flags', () => {
  assert.equal(catalogue.length, 84);
  assert.equal(new Set(catalogue.map(flag => flag.id)).size, 84);
  assert.equal(new Set(catalogue.map(flag => flag.name)).size, 84);
  assert.equal(catalogue.filter(flag => flag.code).length, 82);
  assert.deepEqual(catalogue.filter(flag => !flag.imageUrl).map(flag => flag.name), ['World Gymnastics 1', 'World Gymnastics 2']);
  for (const [code, name] of Object.entries({ TW: 'Chinese Taipei', HK: 'Hong Kong, China', GB: 'Great Britain', CN: "People's Republic of China", IR: 'Islamic Republic of Iran', KR: 'Republic of Korea', TR: 'Türkiye', US: 'United States of America' })) {
    assert.equal(catalogue.find(flag => flag.code === code).name, name);
  }
  for (const flag of catalogue.filter(flag => flag.imageUrl)) {
    const file = flag.source === 'supplied' ? path.join(root, 'public', flag.imageUrl) : path.join(root, 'node_modules/flag-icons', flag.imageUrl);
    assert.ok(fs.statSync(file).size > 0, flag.name);
  }
});

test('all 39 supplied assets match their recorded source or documented PDF conversion', () => {
  const sources = require('../docs/event-flags-sources.json');
  assert.equal(sources.length, 39);
  for (const source of sources) {
    const flag = catalogue.find(flag => flag.code === source.code);
    const data = fs.readFileSync(path.join(root, 'public', flag.imageUrl));
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    assert.equal(hash, source.assetSha256, source.name);
    if (source.conversion === 'Unmodified source file') assert.equal(hash, source.sourceSha256, source.name);
  }
  assert.equal(catalogue.find(flag => flag.code === 'TW').imageUrl, '/event-flags/tw.png');
  const france = fs.readFileSync(path.join(root, 'public/event-flags/fr.svg'), 'utf8');
  assert.ok(france.includes('4.667664%,12.081909%,22.668457%'));
  assert.ok(france.includes('81.364441%,8.892822%,21.220398%'));
  assert.ok(!france.includes('<text'));
});

test('custom flags, event flags and legacy presets resolve consistently without substituting missing flags', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { resolveFlag } from './src/shared/event-flags.ts';
    const slot = { id: 'test', rank: 1, countryCode: 'TW', xOffset: 0 };
    assert.equal(resolveFlag(slot, []).imageUrl, '/event-flags/tw.png');
    assert.equal(resolveFlag({ ...slot, countryCode: 'AU' }, []).imageUrl, '/flags/4x3/au.svg');
    assert.equal(resolveFlag({ ...slot, countryCode: 'AD' }, []).imageUrl, '/flags/4x3/ad.svg');
    assert.equal(resolveFlag({ ...slot, flagId: 'custom' }, [{ id: 'custom', name: 'My flag', imageUrl: '/media/flag.png' }]).imageUrl, '/media/flag.png');
    assert.equal(resolveFlag({ ...slot, flagId: 'event-wg1' }, []).imageUrl, null);
    assert.equal(resolveFlag({ ...slot, flagId: 'event-wg2' }, []).name, 'World Gymnastics 2');
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
