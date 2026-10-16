'use strict';
const assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');

// Local pages and runtime observations only. The caller owns the Electron
// process so this module can share the standard focused smoke-test harness.
module.exports = async function (api, check) {
  const assets = new Map(['/check.html', '/device-probe.cjs', '/check.cjs'].map(name => [name, fs.readFileSync(path.join(__dirname, '../src', name.slice(1)))]));
  const requests = [], server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname; requests.push(pathname);
    const asset = assets.get(pathname);
    if (!asset) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    res.end(asset);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let profile, contents;
  async function waitReport() {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      const result = await contents.executeJavaScript('(()=>{try{const value=JSON.parse(document.querySelector("#raw").textContent);return value.analysis?value:null;}catch{return null;}})()');
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('Local diagnostic report did not finish: ' + await contents.executeJavaScript('document.querySelector("#summary")?.textContent'));
  }
  try {
    profile = api.saveProfile({ name: 'QA measured device diagnostics', fingerprintMode: 'custom', operatingSystem: 'android', deviceModel: 'Pixel 7', osVersion: '14', width: 412, height: 915, screenWidth: 412, screenHeight: 915, deviceScaleFactor: 2.625, maxTouchPoints: 5, hardwareConcurrency: 8, language: 'fr-FR', timezone: 'Europe/Paris', url: origin + '/check.html' });
    await api.launch(profile.id); contents = api.windows.get(profile.id).tabs[0].view.webContents;
    const report = await waitReport();
    await check('local diagnostic UI preserves actual Chromium brands and measures available high-entropy model hints', async () => {
      assert.equal(report.page.features.secureContext, true); assert.equal(report.browserIdentity.uaCompatibility, 'Chrome 兼容声明');
      assert.equal(report.browserIdentity.uaVersion, process.versions.chrome);
      assert.ok(report.browserIdentity.reportedBrands.some(brand => brand.brand === 'Chromium'));
      assert.equal(report.browserIdentity.reportedBrands.some(brand => brand.brand === 'Google Chrome'), false);
      assert.equal(report.browserIdentity.model, 'Pixel 7');
      assert.ok(report.browserIdentity.formFactors === null || Array.isArray(report.browserIdentity.formFactors));
      const text = await contents.executeJavaScript('document.querySelector("#browser-identity").textContent');
      assert.match(text, /Chrome 兼容声明/); assert.match(text, /Chromium/); assert.match(text, /不将 Chromium 改名/);
      assert.equal(await contents.executeJavaScript('document.querySelector("#rerun").disabled'), false);
      return { brands: report.browserIdentity.reportedBrands, model: report.browserIdentity.model, formFactors: report.browserIdentity.formFactors };
    });
    await check('actual WebGPU, local voices and ClientRects retain measured or explicitly limited states', async () => {
      assert.equal(report.clientRects.status, 'measured'); assert.equal(report.clientRects.finite, true); assert.equal(report.clientRects.stable, true); assert.ok(report.clientRects.count > 0);
      assert.equal(await contents.executeJavaScript('document.querySelectorAll("[data-isola-diagnostic]").length'), 0);
      assert.ok(['measured', 'unavailable', 'limited', 'timeout'].includes(report.webgpu.status));
      if (report.webgpu.status === 'measured') { assert.equal(report.webgpu.adapterAvailable, true); assert.equal(typeof report.webgpu.limits, 'object'); }
      else { assert.equal(typeof report.webgpu.adapterAvailable, 'boolean'); assert.equal(typeof report.webgpu.reason, 'string'); }
      assert.ok(['measured', 'unavailable', 'limited', 'timeout'].includes(report.voices.status));
      assert.ok(report.voices.voices.every(voice => voice.localService === true));
      if (report.voices.status === 'measured') assert.ok(report.voices.count > 0);
      assert.ok(report.graphics.canvasStable === true || typeof report.graphics.error === 'string');
      if (report.comparisons.worker.verified) for (const field of ['screen', 'clientRects', 'voices']) assert.equal(report.comparisons.worker.fields.includes(field), false);
      return { webgpu: report.webgpu.status, adapterAvailable: report.webgpu.adapterAvailable, localVoices: report.voices.status, rects: report.clientRects.count };
    });
    await check('diagnostic scope leaves storage isolation and network identity tests unmeasured', async () => {
      for (const id of ['storage-isolation', 'public-ip', 'webrtc-leak', 'tls-dns', 'other-contexts', 'sensitive-devices']) assert.equal(report.scope.find(row => row.id === id).status, 'not-tested');
      assert.equal(report.scope.find(row => row.id === 'identity').status, 'not-verifiable');
      const text = await contents.executeJavaScript('document.querySelector("#scope").textContent');
      assert.match(text, /主进程/); assert.match(text, /未测/); assert.match(text, /TLS/); assert.match(text, /不保证真人/);
      assert.ok(requests.every(url => assets.has(url) || url === '/favicon.ico'));
      return { requestedLocalPaths: [...new Set(requests)], networkChecks: 'not-tested' };
    });
  } finally {
    if (profile) {
      const window = api.windows.get(profile.id); window?.close();
      const until = Date.now() + 15000; while (api.windows.has(profile.id) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
      if (!api.windows.has(profile.id)) await api.deleteProfile(profile.id);
    }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
};
