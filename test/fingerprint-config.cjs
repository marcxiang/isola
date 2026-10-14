const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFingerprintConfig, FINGERPRINT_PRESETS, DEVICE_PRESETS } = require('../src/fingerprint-config.cjs');
const { validate } = require('../src/model.cjs');

const chromeVersion = '145.0.7632.45';
const runtime = {
  platform: 'win32', arch: 'x64', osVersion: '10.0.26200', chromeVersion,
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
};
function config(input = {}, env = runtime) { return buildFingerprintConfig(validate(input), env); }

test('native identity bypasses every device override while preserving network policy', () => {
  const result = config({ fingerprintMode: 'native', operatingSystem: 'ios', ua: 'Custom UA', width: 390, height: 844, hardwareConcurrency: 6, webRTCPolicy: 'default_public_interface_only' });
  assert.equal(result.enabled, false); assert.equal(result.userAgent, runtime.userAgent);
  for (const key of ['userAgentOverride', 'deviceMetrics', 'touchEmulation', 'hardwareConcurrency', 'timezone', 'language', 'acceptLanguage']) assert.equal(result[key], null, key);
  assert.equal(result.webRTCPolicy, 'default_public_interface_only'); assert.equal(result.summary.operatingSystem, 'windows');
  assert.equal(result.summary.architecture, 'x86'); assert.equal(result.summary.customUserAgent, false);
  assert.equal(config({ fingerprintMode: 'native' }).webRTCPolicy, 'disable_non_proxied_udp');
});

test('legacy custom profiles retain host UA and host OS while retaining existing dimensions', () => {
  const result = config({ width: 1440, height: 900, language: 'fr-FR', timezone: 'Europe/Paris' });
  assert.equal(result.enabled, true); assert.equal(result.userAgent, runtime.userAgent); assert.equal(result.userAgentOverride.platform, 'Win32');
  assert.equal(result.userAgentOverride.userAgentMetadata.platform, 'Windows'); assert.equal(result.userAgentOverride.userAgentMetadata.platformVersion, '13.0.0');
  assert.deepEqual(result.deviceMetrics, { width: 1440, height: 900, screenWidth: 1440, screenHeight: 900, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(result.touchEmulation, { enabled: false }); assert.equal(result.acceptLanguage, 'fr-FR'); assert.equal(result.timezone, 'Europe/Paris');
});

test('target OS is independent of the host, and generated UA uses the actual runtime Chrome', () => {
  for (const [operatingSystem, platform, navigatorPlatform] of [['windows', 'Windows', 'Win32'], ['macos', 'macOS', 'MacIntel'], ['linux', 'Linux', 'Linux x86_64'], ['android', 'Android', 'Linux armv8l']]) {
    const result = config({ operatingSystem }, { ...runtime, platform: 'darwin', arch: 'arm64', osVersion: '15.0' });
    assert.equal(result.userAgentOverride.platform, navigatorPlatform); assert.equal(result.userAgentOverride.userAgentMetadata.platform, platform);
    assert.equal(result.userAgentOverride.userAgentMetadata.fullVersion, chromeVersion); assert.ok(result.userAgent.includes(`Chrome/${chromeVersion}`));
    assert.equal(result.summary.operatingSystem, operatingSystem); assert.equal(result.userAgentOverride.userAgentMetadata.mobile, operatingSystem === 'android');
  }
});

test('mobile preset aligns viewport, screen, touch, platform, architecture and UA-CH', () => {
  const result = config({ operatingSystem: 'android', osVersion: '15', hardwareConcurrency: 8 });
  assert.deepEqual(result.deviceMetrics, { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 3, mobile: true });
  assert.deepEqual(result.touchEmulation, { enabled: true, maxTouchPoints: 5 }); assert.equal(result.hardwareConcurrency, 8);
  assert.match(result.userAgent, /Android 15; K/); assert.match(result.userAgent, / Mobile /);
  const metadata = result.userAgentOverride.userAgentMetadata;
  assert.equal(metadata.platform, 'Android'); assert.equal(metadata.platformVersion, '15.0.0'); assert.equal(metadata.architecture, 'arm'); assert.equal(metadata.model, 'K'); assert.equal(metadata.mobile, true);
  assert.deepEqual(result.summary.warnings, []);
  assert.ok(result.summary.limitations.some(s => s.includes('SharedWorker') && s.includes('ServiceWorker') && s.includes('宿主身份')));
});

test('iOS compatibility preset exposes its engine limit and does not invent Chromium UA-CH on iOS', () => {
  const result = config({ operatingSystem: 'ios', osVersion: '18' });
  assert.match(result.userAgent, /iPhone OS 18_0/); assert.ok(result.userAgent.includes(`CriOS/${chromeVersion}`));
  assert.equal(result.userAgentOverride.platform, 'iPhone'); assert.equal(result.userAgentOverride.userAgentMetadata, undefined);
  assert.equal(result.deviceMetrics.mobile, true); assert.equal(result.summary.architecture, 'arm'); assert.equal(result.summary.maxTouchPoints, 5);
  assert.ok(result.summary.limitations.some(s => s.includes('Chromium') && s.includes('WebKit')));
});

test('UA-CH desktop versions and reduced legacy UA remain coherent', () => {
  const win10 = config({ operatingSystem: 'windows', osVersion: '10' }), win11 = config({ operatingSystem: 'windows', osVersion: '11', architecture: 'arm' });
  assert.match(win10.userAgent, /Windows NT 10\.0; Win64; x64/); assert.equal(win10.userAgentOverride.userAgentMetadata.platformVersion, '10.0.0');
  assert.equal(win11.userAgentOverride.userAgentMetadata.platformVersion, '13.0.0'); assert.equal(win11.userAgentOverride.userAgentMetadata.architecture, 'arm');
  const mac = config({ operatingSystem: 'macos', osVersion: '15.3.1', architecture: 'arm' });
  assert.match(mac.userAgent, /Intel Mac OS X 10_15_7/); assert.equal(mac.userAgentOverride.userAgentMetadata.platformVersion, '15.3.1'); assert.equal(mac.userAgentOverride.userAgentMetadata.architecture, 'arm');
  const linux = config({ operatingSystem: 'linux', architecture: 'arm' }); assert.match(linux.userAgent, /Linux aarch64/); assert.equal(linux.userAgentOverride.platform, 'Linux aarch64');
});

test('matching custom UA receives metadata while incompatible or unknown UA does not', () => {
  const generated = config({ operatingSystem: 'android', osVersion: '14' });
  const exact = config({ operatingSystem: 'android', osVersion: '14', ua: generated.userAgent });
  assert.deepEqual(exact.userAgentOverride.userAgentMetadata, generated.userAgentOverride.userAgentMetadata);
  const modelUA = generated.userAgent.replace('; K)', '; Pixel 7 Build/AP1A.240505.004)');
  assert.equal(config({ operatingSystem: 'android', ua: modelUA }).userAgentOverride.userAgentMetadata.model, 'Pixel 7');
  for (const ua of [generated.userAgent.replace(chromeVersion, '99.0.0.0'), generated.userAgent.replace('Android 14', 'Android 13'), runtime.userAgent, 'Legacy Custom UA']) {
    const result = config({ operatingSystem: 'android', ua });
    assert.equal(result.userAgent, ua); assert.equal(result.userAgentOverride.userAgentMetadata, undefined); assert.ok(result.summary.warnings.length > 0);
  }
  assert.equal(config({ operatingSystem: 'android', ua: runtime.userAgent }).userAgentOverride.platform, 'Win32');
});

test('advanced geometry and touch overrides remain possible with clear consistency warnings', () => {
  const mobile = config({ operatingSystem: 'android', maxTouchPoints: 0, width: 412, height: 915, screenWidth: 390, screenHeight: 844 });
  assert.equal(mobile.deviceMetrics.width, 412); assert.deepEqual(mobile.touchEmulation, { enabled: false }); assert.equal(mobile.summary.warnings.length, 2);
  const desktop = config({ operatingSystem: 'windows', maxTouchPoints: 10 }); assert.deepEqual(desktop.touchEmulation, { enabled: true, maxTouchPoints: 10 }); assert.equal(desktop.summary.warnings.length, 1);
});

test('host OS release suffixes cannot produce invalid UA-CH numeric versions', () => {
  const linuxRuntime = { ...runtime, platform: 'linux', osVersion: '6.8.0-1018-generic', userAgent: runtime.userAgent.replace('Windows NT 10.0; Win64; x64', 'X11; Linux x86_64') };
  assert.equal(config({}, linuxRuntime).userAgentOverride.userAgentMetadata.platformVersion, '6.8.0');
});

test('builder rejects header injection independently and does not invent an unknown Chrome version', () => {
  assert.throws(() => buildFingerprintConfig({ ua: 'Bad\r\nHeader: value' }, runtime));
  assert.throws(() => buildFingerprintConfig({}, { ...runtime, userAgent: 'bad\nUA' }));
  assert.throws(() => buildFingerprintConfig({ operatingSystem: 'android' }, { platform: 'win32', chromeVersion: '' }));
  assert.equal(buildFingerprintConfig({ operatingSystem: 'android', ua: 'Explicit legacy UA' }, { chromeVersion: '' }).userAgent, 'Explicit legacy UA');
});

test('builder has no profile mutations and presets cannot be modified', () => {
  const profile = validate({ operatingSystem: 'android' }); const before = JSON.stringify(profile);
  buildFingerprintConfig(profile, runtime); assert.equal(JSON.stringify(profile), before);
  assert.equal(Object.isFrozen(FINGERPRINT_PRESETS), true); assert.equal(Object.isFrozen(FINGERPRINT_PRESETS.android), true);
});

test('selectable device presets populate coherent model, screen, DPR, touch and CPU fields', () => {
  const expected = {
    pixel7: ['android', 'Pixel 7', 412, 915, 2.625, 8],
    'galaxy-s23': ['android', 'SM-S911B', 360, 780, 3, 8],
    iphone13: ['ios', 'iPhone 13', 390, 844, 3, 6],
    iphone14pro: ['ios', 'iPhone 14 Pro', 393, 852, 3, 6]
  };
  for (const [key, [target, model, width, height, dpr, cpu]] of Object.entries(expected)) {
    const preset = DEVICE_PRESETS[key], result = config(preset);
    assert.equal(preset.type, 'mobile'); assert.equal(preset.deviceModel, model); assert.equal(preset.operatingSystem, target);
    assert.equal(result.deviceMetrics.width, width); assert.equal(result.deviceMetrics.height, height); assert.equal(result.deviceMetrics.screenWidth, width); assert.equal(result.deviceMetrics.screenHeight, height);
    assert.equal(result.deviceMetrics.deviceScaleFactor, dpr); assert.equal(result.hardwareConcurrency, cpu); assert.deepEqual(result.touchEmulation, { enabled: true, maxTouchPoints: 5 });
    assert.equal(result.summary.deviceModel, model); assert.equal(result.summary.mobile, true); assert.equal(result.summary.architecture, 'arm');
    if (target === 'android') { assert.ok(result.userAgent.includes(`; ${model})`)); assert.equal(result.userAgentOverride.userAgentMetadata.model, model); }
    assert.ok(Object.isFrozen(preset));
  }
  assert.ok(Object.isFrozen(DEVICE_PRESETS));
  const desktop = config(DEVICE_PRESETS['native-desktop']);
  assert.equal(desktop.deviceMetrics.mobile, false); assert.equal(desktop.userAgent, runtime.userAgent); assert.deepEqual(desktop.touchEmulation, { enabled: false }); assert.equal(desktop.hardwareConcurrency, null);
  assert.equal(config(DEVICE_PRESETS['generic-android']).summary.mobile, true);
});

test('a chosen model never silently resets explicit editable profile fields', () => {
  const result = config({ ...DEVICE_PRESETS.pixel7, osVersion: '15', width: 400, height: 900, screenWidth: 410, screenHeight: 910, deviceScaleFactor: 2, maxTouchPoints: 3, hardwareConcurrency: 4 });
  assert.equal(result.deviceMetrics.width, 400); assert.equal(result.deviceMetrics.height, 900); assert.equal(result.deviceMetrics.screenWidth, 410); assert.equal(result.deviceMetrics.screenHeight, 910); assert.equal(result.deviceMetrics.deviceScaleFactor, 2);
  assert.deepEqual(result.touchEmulation, { enabled: true, maxTouchPoints: 3 }); assert.equal(result.hardwareConcurrency, 4); assert.match(result.userAgent, /Android 15; Pixel 7/);
});

test('an explicit Android model is retained in high entropy hints when the UA is reduced', () => {
  const reducedUA = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion.split('.')[0]}.0.0.0 Mobile Safari/537.36`;
  const result = config({ ...DEVICE_PRESETS.pixel7, ua: reducedUA });
  assert.equal(result.userAgent, reducedUA); assert.equal(result.userAgentOverride.userAgentMetadata.model, 'Pixel 7'); assert.equal(result.userAgentOverride.userAgentMetadata.platformVersion, '14.0.0');
  assert.equal(result.userAgentOverride.userAgentMetadata.fullVersion, chromeVersion); assert.deepEqual(result.summary.warnings, []);
  const mismatched = config({ ...DEVICE_PRESETS.pixel7, ua: reducedUA.replace('Android 10; K', 'Android 14; Pixel 6') });
  assert.equal(mismatched.userAgentOverride.userAgentMetadata, undefined); assert.ok(mismatched.summary.warnings.length);
});

test('builder independently rejects unsafe model input', () => {
  for (const deviceModel of ['A\r\nX: injected', 'X); Windows NT 10.0', 'X'.repeat(81)]) assert.throws(() => buildFingerprintConfig({ operatingSystem: 'android', deviceModel }, runtime));
});
