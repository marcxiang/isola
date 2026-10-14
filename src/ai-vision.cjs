const { nativeImage } = require('electron');
const { isolated } = require('./page-control.cjs');
const {getDisplayState}=require('./display-transform.cjs');

function visionError(code, message) { const error = new Error(message); error.code = code; return error; }
function abort(signal) { if (signal?.aborted) throw visionError('ABORTED', '任务已停止'); }
function originOf(url) { try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) ? parsed.origin : null; } catch { return null; } }

// Runs in the existing isolated world. Values, labels and frame contents are never returned.
function collectMaskGeometry() {
  const rects = [], viewport = { width: innerWidth, height: innerHeight, x: scrollX, y: scrollY };
  let visited = 0, overflow = false, opaque = false;
  const sensitive = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[autocomplete],[data-private],[data-sensitive],[data-1p-ignore],iframe,frame,object,embed,canvas';
  function addRect(r) {
    if (![r.left, r.top, r.right, r.bottom].every(Number.isFinite)) { overflow = true; return; }
    if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return;
    rects.push({ left: Math.max(0, r.left - 16), top: Math.max(0, r.top - 16), right: Math.min(innerWidth, r.right + 16), bottom: Math.min(innerHeight, r.bottom + 16) });
    if (rects.length > 2500) overflow = true;
  }
  function include(element, contents = false) {
    const candidates = [element];
    if (contents) {
      const descendants = element.querySelectorAll('*');
      if (descendants.length > 2500) { overflow = true; return; }
      candidates.push(...descendants);
      // Editable text can overflow its element without creating an element box.
      const range = document.createRange(); range.selectNodeContents(element);
      for (const rect of range.getClientRects()) { addRect(rect); if (overflow) return; }
    }
    for (const item of candidates) {
      const style = getComputedStyle(item);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // Include painting beyond the border box and leave room for antialiasing/resize filters.
      addRect(item.getBoundingClientRect());
      if (overflow) return;
    }
  }
  function walk(root) {
    for (const element of root.querySelectorAll('*')) {
      if (++visited > 20000 || overflow) { overflow = true; return; }
      const custom = element.localName.includes('-');
      if (custom && !element.shadowRoot) {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        if (rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden') opaque = true;
      }
      if (element.matches(sensitive) || custom) include(element, element.isContentEditable || custom || element.hasAttribute('data-private') || element.hasAttribute('data-sensitive'));
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  }
  walk(document);
  const visual = visualViewport ? { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale, x: visualViewport.offsetLeft, y: visualViewport.offsetTop } : null;
  return { viewport, visual, rects, overflow, opaque, ready: document.readyState, url: location.href };
}

const GEOMETRY_SOURCE = '(' + collectMaskGeometry.toString() + ')()';
function stableGeometry(a, b) {
  if (a.url !== b.url || a.overflow || b.overflow || a.opaque || b.opaque || a.rects.length !== b.rects.length) return false;
  if (JSON.stringify(a.viewport) !== JSON.stringify(b.viewport) || JSON.stringify(a.visual) !== JSON.stringify(b.visual)) return false;
  return a.rects.every((rect, index) => Object.keys(rect).every(key => Math.abs(rect[key] - b.rects[index][key]) < 0.25));
}
function checkGeometry(geometry, bounds, zoom) {
  const { viewport, visual } = geometry;
  if (geometry.overflow || geometry.ready === 'loading') throw visionError('VISION_LAYOUT_UNSAFE', '页面仍在变化或内容过多，暂时使用文字信息继续');
  if (geometry.opaque) throw visionError('VISION_LAYOUT_UNSAFE', '页面含有无法可靠检查输入区的组件，暂时使用文字信息继续');
  if (!viewport || ![viewport.width, viewport.height, bounds.width, bounds.height, zoom].every(Number.isFinite) || viewport.width < 2 || viewport.height < 2 || bounds.x < 0 || bounds.y < 0) throw visionError('VISION_GEOMETRY_UNSAFE', '当前页面不可见，暂时使用文字信息继续');
  // Emulation can render a viewport independently of the native view and crop its surface.
  // Never infer a crop/scale from a ratio alone: only a matching native viewport is accepted.
  if (Math.abs(zoom - 1) > 0.001 || Math.abs(viewport.width - bounds.width) > 1 || Math.abs(viewport.height - bounds.height) > 1 || !visual || Math.abs(visual.scale - 1) > 0.001 || Math.abs(visual.x) > 0.1 || Math.abs(visual.y) > 0.1) {
    throw visionError('VISION_GEOMETRY_UNSAFE', '当前缩放或自定义视口无法可靠遮盖输入区，已改用文字信息；原生设备模式和 100% 缩放可使用视觉辅助');
  }
}

async function captureModelImage(tab, { signal, allowedOrigins } = {}) {
  abort(signal);
  const c = tab?.view?.webContents;
  if (!c || c.isDestroyed()) throw visionError('VISION_UNAVAILABLE', '当前页面已关闭，无法获取视觉信息');
  const display=getDisplayState(c);
  if(!display.ready||display.scale!==1)throw visionError('VISION_GEOMETRY_UNSAFE','当前窗口正更新或缩小显示，已改用文字信息继续');
  const initialURL = c.getURL(), origin = originOf(initialURL);
  if (!origin || allowedOrigins && !allowedOrigins.has(origin)) throw visionError('VISION_ORIGIN_UNAPPROVED', '当前站点尚未获准读取，未截取页面');
  let png, bitmap;
  try {
    const before = await isolated(tab, GEOMETRY_SOURCE);
    abort(signal);
    if(getDisplayState(c).version!==display.version||!getDisplayState(c).ready)throw visionError('VISION_LAYOUT_CHANGED','窗口显示比例已改变，本次不发送截图');
    const bounds = tab.view.getBounds(), zoom = c.getZoomFactor();
    checkGeometry(before, bounds, zoom);
    const captured = await c.capturePage();
    abort(signal);
    const after = await isolated(tab, GEOMETRY_SOURCE);
    if (getDisplayState(c).version!==display.version||!getDisplayState(c).ready||getDisplayState(c).scale!==1||c.getURL() !== initialURL || after.url !== initialURL || !stableGeometry(before, after) || JSON.stringify(tab.view.getBounds()) !== JSON.stringify(bounds) || c.getZoomFactor() !== zoom) throw visionError('VISION_LAYOUT_CHANGED', '页面正在移动或跳转，本次不发送截图，暂时使用文字信息继续');
    if (captured.isEmpty()) throw visionError('VISION_UNAVAILABLE', '页面截图为空，暂时使用文字信息继续');
    // A PNG round-trip removes NativeImage representation-scale ambiguity on Retina displays.
    // Read physical pixel dimensions from the PNG header, then work on a 1x representation.
    png = captured.toPNG();
    if (png.length < 24 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw visionError('VISION_UNAVAILABLE', '页面图像格式无法识别，暂时使用文字信息继续');
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20), sx = width / before.viewport.width, sy = height / before.viewport.height;
    if (!width || !height || width * height > 40000000 || sx < 0.25 || sx > 4 || Math.abs(sx - sy) > 0.005) throw visionError('VISION_GEOMETRY_UNSAFE', '页面截图比例无法可靠校验，暂时使用文字信息继续');
    const normalized = nativeImage.createFromBuffer(png);
    bitmap = normalized.toBitmap();
    if (bitmap.length !== width * height * 4) throw visionError('VISION_GEOMETRY_UNSAFE', '页面像素尺寸无法可靠校验，暂时使用文字信息继续');
    const maskPixel = Buffer.from([40, 40, 40, 255]);
    let maskWork = 0;
    for (const rect of before.rects) {
      const left = Math.max(0, Math.floor(rect.left * sx)), right = Math.min(width, Math.ceil(rect.right * sx));
      const top = Math.max(0, Math.floor(rect.top * sy)), bottom = Math.min(height, Math.ceil(rect.bottom * sy));
      maskWork += (right - left) * (bottom - top);
      if (maskWork > width * height * 8) throw visionError('VISION_LAYOUT_UNSAFE', '页面输入区结构过于复杂，本次使用文字信息继续');
      for (let y = top; y < bottom; y++) bitmap.fill(maskPixel, (y * width + left) * 4, (y * width + right) * 4);
    }
    abort(signal);
    let redacted = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
    const scale = Math.min(1, 1280 / Math.max(width, height));
    if (scale < 1) redacted = redacted.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' });
    const size = redacted.getSize(), encoded = redacted.toJPEG(70);
    if (!encoded.length) throw visionError('VISION_UNAVAILABLE', '页面图像编码失败，暂时使用文字信息继续');
    abort(signal);
    return { dataURL: 'data:image/jpeg;base64,' + encoded.toString('base64'), width: size.width, height: size.height, maskedRegions: before.rects.length };
  } finally {
    // Raw page pixels never enter the tool history or logs.
    png?.fill(0);
    bitmap?.fill(0);
  }
}

module.exports = { captureModelImage };
