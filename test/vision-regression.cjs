const http = require('node:http');
const assert = require('node:assert/strict');

module.exports = async function visionRegression(api, check) {
  const { nativeImage } = require('electron');
  const { captureModelImage } = require('../src/ai-vision.cjs');
  const secret = 'VISION_PRIVATE_FIXTURE_97531';
  const fixture = `<!doctype html><meta charset="utf-8"><title>Vision privacy fixture</title><style>
    body{margin:0;background:white;font:16px sans-serif}input,textarea,select,[contenteditable],#shadow,secret-widget,iframe,canvas{position:absolute;left:40px;width:240px;height:38px;box-sizing:border-box;background:rgb(220,30,30);color:white;border:0}#normal{top:40px}#password{top:100px}textarea{top:160px}select{top:220px}[contenteditable]{top:280px}#shadow{top:340px}iframe{top:400px;height:60px}secret-widget{top:490px;height:48px}canvas{top:580px}#public{position:absolute;left:370px;top:60px;width:200px;height:120px;background:rgb(20,180,80)}
    </style><div id="public">Public page content</div><input id="normal" value="${secret}"><input id="password" type="password" value="${secret}"><textarea>${secret}</textarea><select><option>${secret}</option></select><div contenteditable>${secret}</div><div id="shadow"></div><iframe src="/frame"></iframe><secret-widget style="display:none"></secret-widget><canvas width="240" height="38"></canvas><script>
    const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML='<input style="width:240px;height:38px;border:0;background:rgb(220,30,30);color:white" value="${secret}">';
    document.querySelector('secret-widget').attachShadow({mode:'closed'}).innerHTML='<div style="width:240px;height:48px;background:rgb(220,30,30)">${secret}</div>';
    const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='rgb(220,30,30)';ctx.fillRect(0,0,240,38);ctx.fillStyle='white';ctx.fillText('${secret}',4,20);
    </script>`;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.url === '/frame' ? '<!doctype html><body style="margin:0;background:rgb(220,30,30)">' + secret : fixture.replace('src="/frame"', 'src="http://localhost:' + server.address().port + '/frame"'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, allowedOrigins = new Set([origin]);
  let profile, window, customProfile, customWindow, originalThrottling;
  try {
    profile = api.saveProfile({ name: 'QA private visual input', url: origin, fingerprintMode: 'native', width: 1200, height: 760 });
    await api.launch(profile.id);
    window = api.windows.get(profile.id);
    const tab = window.tabs[0], c = tab.view.webContents;
    // Pixel privacy checks need a painted foreground fixture on Windows.
    // Production treats unavailable optional screenshots as text-only input.
    window.show(); window.focus(); c.focus();
    originalThrottling = c.getBackgroundThrottling(); c.setBackgroundThrottling(false);
    await c.executeJavaScript('new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Vision fixture did not paint")),1500);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)}));})');
    let capture;
    await check('visual input masks fields, editable text, open shadows, frames and canvas', async () => {
      const before = await c.executeJavaScript('document.documentElement.outerHTML');
      capture = await captureModelImage(tab, { allowedOrigins });
      const viewport = await c.executeJavaScript('({width:innerWidth,height:innerHeight})');
      const decoded = nativeImage.createFromDataURL(capture.dataURL), size = decoded.getSize(), pixels = decoded.toBitmap();
      assert.ok(capture.dataURL.startsWith('data:image/jpeg;base64,'));
      assert.equal(size.width, capture.width); assert.equal(size.height, capture.height);
      assert.ok(Math.max(size.width, size.height) <= 1280);
      assert.ok(capture.maskedRegions >= 8);
      for (const y of [59, 119, 179, 239, 299, 359, 430, 599]) {
        const px = Math.floor(100 * size.width / viewport.width), py = Math.floor(y * size.height / viewport.height), offset = (py * size.width + px) * 4;
        assert.ok([...pixels.subarray(offset, offset + 3)].every(value => Math.abs(value - 40) < 5), 'Region at y=' + y + ' was not masked');
      }
      const publicOffset = (Math.floor(140 * size.height / viewport.height) * size.width + Math.floor(450 * size.width / viewport.width)) * 4;
      assert.ok(pixels[publicOffset + 1] > 140, 'Non-sensitive public content should remain visible');
      assert.equal(await c.executeJavaScript('document.documentElement.outerHTML'), before, 'Masking must not change page DOM');
      assert.equal(await c.executeJavaScript('document.querySelector("#normal").value'), secret);
      assert.deepEqual(Object.keys(capture).sort(), ['dataURL', 'height', 'maskedRegions', 'width']);
      assert.ok(!JSON.stringify(capture).includes(secret));
      return { width: capture.width, height: capture.height, maskedRegions: capture.maskedRegions, nativeScale: size.width / viewport.width };
    });
    await check('visual input rejects unapproved origins and already aborted tasks', async () => {
      await assert.rejects(captureModelImage(tab, { allowedOrigins: new Set() }), error => error.code === 'VISION_ORIGIN_UNAPPROVED');
      const controller = new AbortController(); controller.abort();
      await assert.rejects(captureModelImage(tab, { signal: controller.signal, allowedOrigins }), error => error.code === 'ABORTED');
    });
    await check('visual input omits a screenshot when an opaque custom component is visible', async () => {
      await c.executeJavaScript('document.querySelector("secret-widget").style.display="block"');
      try { await assert.rejects(captureModelImage(tab, { allowedOrigins }), error => error.code === 'VISION_LAYOUT_UNSAFE'); }
      finally { await c.executeJavaScript('document.querySelector("secret-widget").style.display="none"'); }
    });
    await check('visual input stops when cancellation arrives during native capture', async () => {
      const controller = new AbortController();
      const wrappedContents = new Proxy(c, { get(target, key) {
        if (key === 'capturePage') return async (...args) => { const image = await target.capturePage(...args); controller.abort(); return image; };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const wrapped = { ...tab, view: { webContents: wrappedContents, getBounds: () => tab.view.getBounds() } };
      await assert.rejects(captureModelImage(wrapped, { signal: controller.signal, allowedOrigins }), error => error.code === 'ABORTED');
    });
    await check('visual input refuses unsupported zoom rather than guessing mask coordinates', async () => {
      c.setZoomFactor(1.25);
      try { await assert.rejects(captureModelImage(tab, { allowedOrigins }), error => error.code === 'VISION_GEOMETRY_UNSAFE'); }
      finally { c.setZoomFactor(1); }
    });
    await check('custom emulated viewport is rejected when native view geometry differs', async () => {
      customProfile = api.saveProfile({ name: 'QA custom visual geometry', url: origin, fingerprintMode: 'custom', width: 1200, height: 760 });
      await api.launch(customProfile.id); customWindow = api.windows.get(customProfile.id);
      const customTab = customWindow.tabs[0], bounds = customTab.view.getBounds();
      const viewport = await customTab.view.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
      assert.ok(Math.abs(viewport.width - bounds.width) > 1 || Math.abs(viewport.height - bounds.height) > 1, 'Fixture must exercise mismatched emulation geometry');
      await assert.rejects(captureModelImage(customTab, { allowedOrigins }), error => error.code === 'VISION_GEOMETRY_UNSAFE');
      return { viewport, nativeView: { width: bounds.width, height: bounds.height }, behavior: 'text-only fallback required' };
    });
  } finally {
    const contents = window?.tabs[0]?.view.webContents;
    if (contents && !contents.isDestroyed() && originalThrottling !== undefined) contents.setBackgroundThrottling(originalThrottling);
    for (const w of [window, customWindow]) if (w && !w.isDestroyed()) w.close();
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const p of [profile, customProfile]) if (p) await api.deleteProfile(p.id);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
};
