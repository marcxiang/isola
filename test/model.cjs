const { test } = require('node:test'), assert = require('node:assert/strict');
const { validate, proxyConfig, publicProfile, exportProfiles, importProfiles } = require('../src/model.cjs');
test('profile identifiers are independent', () => { const a = validate({}), b = validate({}); assert.notEqual(a.id, b.id); assert.equal(a.timezone, 'Asia/Shanghai'); assert.equal(a.fingerprintMode,'custom'); assert.equal(validate({fingerprintMode:'native'}).fingerprintMode,'native'); assert.throws(()=>validate({fingerprintMode:'invalid'})); });
test('reject unsafe URLs, path identifiers and UA header injection', () => { for (const p of [{url:'file:///etc/passwd'}, {url:'javascript:alert(1)'}, {url:'https://user:secret@example.com'}, {id:'../../escape'}, {ua:'X\r\nInjected: value'}]) assert.throws(() => validate(p)); });
test('proxy input validates host, port and credentials', () => { for (const proxy of [{type:'http',host:'a;direct',port:80}, {type:'http',host:'host',port:70000}, {type:'socks5',host:'host',port:1080,password:'secret'}]) assert.throws(() => validate({proxy})); assert.equal(validate({proxy:{type:'socks5',host:'::1',port:1080,username:'u',password:'p'}}).proxy.host,'::1'); assert.equal(validate({proxy:{type:'http',host:'EXAMPLE.COM',port:80}}).proxy.host,'example.com'); });
test('proxy config has no direct fallback, including loopback targets', () => { assert.deepEqual(proxyConfig({type:'http',host:'127.0.0.1',port:8080}), {mode:'fixed_servers',proxyRules:'http://127.0.0.1:8080',proxyBypassRules:'<-loopback>'}); assert.equal(proxyConfig({type:'socks5',host:'::1',port:1080}).proxyRules, 'socks5://[::1]:1080'); });
test('reject invalid timezones, dimensions and CPU values', () => { for (const p of [{timezone:'Wrong/Zone'}, {width:-1}, {height:0}, {hardwareConcurrency:65}]) assert.throws(() => validate(p)); });
test('UI and exports never contain proxy password', () => { const p=validate({proxy:{type:'http',host:'localhost',port:80,username:'secret-user',password:'secret-pass'}}); const ui=publicProfile(p); assert.equal(ui.proxy.password,undefined); assert.equal(ui.proxy.hasPassword,true); const exported=JSON.stringify(exportProfiles([p])); assert.ok(!exported.includes('secret-pass')); assert.ok(!exported.includes('secret-user')); });
test('imports get new identities and strip credentials', () => { const p=validate({name:'A',proxy:{username:'user',password:'pass'}}); const result=importProfiles({format:'isola-profiles',version:1,profiles:[p,p]}); assert.notEqual(result[0].id,p.id); assert.notEqual(result[0].id,result[1].id); assert.equal(result[0].proxy.password,''); assert.throws(()=>importProfiles({profiles:[p]})); });

test('legacy profile migration preserves mode, UA, viewport and CPU choices', () => {
  for (const mode of ['native', 'custom']) {
    const p = validate({ fingerprintMode: mode, ua: 'Custom legacy UA', width: 1440, height: 900, hardwareConcurrency: 6 });
    assert.equal(p.fingerprintMode, mode); assert.equal(p.ua, 'Custom legacy UA');
    assert.equal(p.operatingSystem, 'native'); assert.equal(p.osVersion, ''); assert.equal(p.deviceModel, '');
    assert.equal(p.width, 1440); assert.equal(p.height, 900); assert.equal(p.screenWidth, 1440); assert.equal(p.screenHeight, 900);
    assert.equal(p.hardwareConcurrency, 6); assert.equal(p.deviceScaleFactor, 1); assert.equal(p.maxTouchPoints, 0);
    assert.equal(p.webRTCPolicy, 'disable_non_proxied_udp');
  }
});

test('new mobile profiles get a coherent default screen, pixel ratio and touch', () => {
  for (const operatingSystem of ['android', 'ios']) {
    const p = validate({ operatingSystem });
    assert.equal(p.width, 390); assert.equal(p.height, 844); assert.equal(p.screenWidth, p.width); assert.equal(p.screenHeight, p.height);
    assert.equal(p.architecture, 'arm'); assert.equal(p.deviceScaleFactor, 3); assert.equal(p.maxTouchPoints, 5);
  }
  const p = validate({ operatingSystem: 'android', width: 412, height: 915, deviceScaleFactor: 2.625 });
  assert.equal(p.screenWidth, 412); assert.equal(p.screenHeight, 915); assert.equal(p.deviceScaleFactor, 2.625);
});

test('fingerprint settings validate OS, versions, architecture and numeric bounds', () => {
  for (const p of [
    { operatingSystem: 'beos' }, { operatingSystem: '__proto__' }, { operatingSystem: ['native'] },
    { operatingSystem: 'windows', osVersion: '12' }, { operatingSystem: 'android', osVersion: '7' },
    { operatingSystem: 'ios', osVersion: '17; injected' }, { operatingSystem: 'macos', osVersion: '14.0.0.1' },
    { operatingSystem: 'linux', osVersion: '6.8-foo' }, { architecture: 'arm64' }, { operatingSystem: 'ios', architecture: 'x86' },
    { deviceScaleFactor: 0.5 }, { deviceScaleFactor: 4.1 }, { deviceScaleFactor: Infinity },
    { maxTouchPoints: -1 }, { maxTouchPoints: 11 }, { maxTouchPoints: 1.5 },
    { screenWidth: 0 }, { screenHeight: 7681 }, { screenHeight: NaN }, { webRTCPolicy: 'all' }
  ]) assert.throws(() => validate(p), JSON.stringify(p));
  for (const p of [{ operatingSystem: 'windows', osVersion: '10', architecture: 'arm' }, { operatingSystem: 'macos', osVersion: '15.3.1' }, { operatingSystem: 'android', osVersion: '15' }, { operatingSystem: 'linux', osVersion: '6.8' }, { operatingSystem: 'ios', osVersion: '18.0' }]) assert.doesNotThrow(() => validate(p));
});

test('UA validation rejects control characters even when trimming would hide them', () => {
  for (const ua of ['Normal\r\n', '\tNormal', 'A\0B', 'A\x7fB', ' '.repeat(1025)]) assert.throws(() => validate({ ua }));
});

test('fingerprint export and import preserve choices without credentials', () => {
  const p = validate({ operatingSystem: 'android', osVersion: '15', deviceModel: 'Pixel 7', width: 412, height: 915, deviceScaleFactor: 2.625, screenWidth: 412, screenHeight: 915, hardwareConcurrency: 8, webRTCPolicy: 'default_public_interface_only' });
  const [imported] = importProfiles(exportProfiles([p]));
  for (const key of ['operatingSystem', 'osVersion', 'architecture', 'deviceModel', 'width', 'height', 'screenWidth', 'screenHeight', 'deviceScaleFactor', 'maxTouchPoints', 'hardwareConcurrency', 'webRTCPolicy']) assert.equal(imported[key], p[key], key);
});

test('device model is preserved as a safe UA token and cannot inject headers or system tokens', () => {
  assert.equal(validate({ operatingSystem: 'android', deviceModel: '  SM-S911B  ' }).deviceModel, 'SM-S911B');
  for (const deviceModel of ['Pixel 7\r\nInjected: value', 'Pixel 7\n', 'Pixel\0', 'Pixel\t7', 'Pixel\u0085', 'Pixel\u2028', 'Pixel\u200b', 'X); Windows NT 10.0', 'X; Another', 'X'.repeat(81), 42, {}]) assert.throws(() => validate({ operatingSystem: 'android', deviceModel }));
});
