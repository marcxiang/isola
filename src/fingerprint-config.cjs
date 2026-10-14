const os = require('node:os');

// These are compatibility presets. The selected OS never changes the host or
// Chromium engine, graphics stack, fonts, or browser automation interfaces.
const FINGERPRINT_PRESETS = Object.freeze({
  native: Object.freeze({ label: '跟随本机', osVersion: '', architecture: process.arch === 'arm64' ? 'arm' : 'x86', width: 1280, height: 800, deviceScaleFactor: 1, maxTouchPoints: 0 }),
  windows: Object.freeze({ label: 'Windows', osVersion: '11', architecture: 'x86', width: 1280, height: 800, deviceScaleFactor: 1, maxTouchPoints: 0 }),
  macos: Object.freeze({ label: 'macOS', osVersion: '14.0', architecture: 'arm', width: 1280, height: 800, deviceScaleFactor: 2, maxTouchPoints: 0 }),
  linux: Object.freeze({ label: 'Linux', osVersion: '6.8.0', architecture: 'x86', width: 1280, height: 800, deviceScaleFactor: 1, maxTouchPoints: 0 }),
  android: Object.freeze({ label: 'Android', osVersion: '14', architecture: 'arm', width: 390, height: 844, deviceScaleFactor: 3, maxTouchPoints: 5 }),
  ios: Object.freeze({ label: 'iOS', osVersion: '17.0', architecture: 'arm', width: 390, height: 844, deviceScaleFactor: 3, maxTouchPoints: 5 })
});
// CSS dimensions and DPR follow mobile browser emulation conventions; presets
// populate editable fields rather than replacing a user's stored overrides.
// Pixel 7 and iPhone 14 Pro geometry can also be checked in Chromium DevTools:
// https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/emulation/EmulatedDevices.ts
function devicePreset(label, type, operatingSystem, deviceModel, overrides = {}) {
  const base = FINGERPRINT_PRESETS[operatingSystem];
  const values = { operatingSystem, osVersion: base.osVersion, architecture: base.architecture, deviceModel, width: base.width, height: base.height, deviceScaleFactor: base.deviceScaleFactor, maxTouchPoints: base.maxTouchPoints, hardwareConcurrency: 0, ...overrides };
  return Object.freeze({ label, type, ...values, screenWidth: values.width, screenHeight: values.height });
}
const DEVICE_PRESETS = Object.freeze({
  'native-desktop': devicePreset('桌面 / 跟随本机', 'desktop', 'native', ''),
  'generic-android': devicePreset('通用 Android 手机', 'mobile', 'android', '', { hardwareConcurrency: 8 }),
  pixel7: devicePreset('Google Pixel 7', 'mobile', 'android', 'Pixel 7', { width: 412, height: 915, deviceScaleFactor: 2.625, hardwareConcurrency: 8 }),
  'galaxy-s23': devicePreset('Samsung Galaxy S23', 'mobile', 'android', 'SM-S911B', { width: 360, height: 780, hardwareConcurrency: 8 }),
  iphone13: devicePreset('iPhone 13', 'mobile', 'ios', 'iPhone 13', { hardwareConcurrency: 6 }),
  iphone14pro: devicePreset('iPhone 14 Pro', 'mobile', 'ios', 'iPhone 14 Pro', { width: 393, height: 852, hardwareConcurrency: 6 })
});
const WEBRTC_POLICIES = Object.freeze(['disable_non_proxied_udp', 'default_public_interface_only', 'default']);
const OS_NAMES = Object.freeze({ windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS' });

function normalizeFingerprintSettings(input = {}) {
  const fingerprintMode = input.fingerprintMode ?? 'custom';
  if (!['native', 'custom'].includes(fingerprintMode)) throw Error('指纹模式无效');
  const operatingSystem = input.operatingSystem ?? 'native';
  if (typeof operatingSystem !== 'string' || !Object.hasOwn(FINGERPRINT_PRESETS, operatingSystem)) throw Error('操作系统无效');
  const preset = FINGERPRINT_PRESETS[operatingSystem];
  const osVersion = String(input.osVersion ?? preset.osVersion).trim();
  const architecture = input.architecture ?? preset.architecture;
  if (!['x86', 'arm'].includes(architecture)) throw Error('架构须为 x86 或 arm');
  if (['android', 'ios'].includes(operatingSystem) && architecture !== 'arm') throw Error('手机兼容预设须使用 ARM 架构');
  validateOSVersion(operatingSystem, osVersion);
  if (input.deviceModel != null && typeof input.deviceModel !== 'string') throw Error('设备型号须为文字');
  const rawDeviceModel = input.deviceModel ?? '', deviceModel = rawDeviceModel.trim();
  // Parentheses and semicolons delimit the Android UA's system token. Reject
  // them rather than silently rewriting a model into a different identity.
  if (deviceModel.length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}();]/u.test(rawDeviceModel)) throw Error('设备型号最多 80 个字符，不能包含控制字符、括号或分号');
  const width = Number(input.width ?? preset.width), height = Number(input.height ?? preset.height);
  for (const value of [width, height]) if (!Number.isInteger(value) || value < 320 || value > 3840) throw Error('视口尺寸须为 320–3840 的整数');
  const screenWidth = Number(input.screenWidth ?? width), screenHeight = Number(input.screenHeight ?? height);
  for (const value of [screenWidth, screenHeight]) if (!Number.isInteger(value) || value < 320 || value > 7680) throw Error('屏幕尺寸须为 320–7680 的整数');
  const deviceScaleFactor = Number(input.deviceScaleFactor ?? preset.deviceScaleFactor);
  if (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 1 || deviceScaleFactor > 4) throw Error('设备像素比须为 1–4');
  const maxTouchPoints = Number(input.maxTouchPoints ?? preset.maxTouchPoints);
  if (!Number.isInteger(maxTouchPoints) || maxTouchPoints < 0 || maxTouchPoints > 10) throw Error('触摸点数须为 0–10 的整数');
  const hardwareConcurrency = Number(input.hardwareConcurrency ?? 0);
  if (!Number.isInteger(hardwareConcurrency) || hardwareConcurrency < 0 || hardwareConcurrency > 64) throw Error('CPU 核数须为 0–64 的整数，0 表示默认');
  const webRTCPolicy = input.webRTCPolicy ?? 'disable_non_proxied_udp';
  if (!WEBRTC_POLICIES.includes(webRTCPolicy)) throw Error('WebRTC 策略无效');
  return { fingerprintMode, operatingSystem, osVersion, architecture, deviceModel, width, height, screenWidth, screenHeight, deviceScaleFactor, maxTouchPoints, hardwareConcurrency, webRTCPolicy };
}

function validateOSVersion(operatingSystem, version) {
  if (operatingSystem === 'native') {
    if (version && !/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(version)) throw Error('操作系统版本须为数字版本号');
    return;
  }
  if (operatingSystem === 'windows') {
    if (!['10', '11'].includes(version)) throw Error('Windows 版本请选择 10 或 11');
    return;
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(version)) throw Error('操作系统版本须为数字版本号，例如 14.0');
  const major = Number(version.split('.')[0]);
  const min = { macos: 10, linux: 1, android: 8, ios: 12 }[operatingSystem];
  if (major < min || major > 99) throw Error('操作系统版本超出支持范围');
}

function normalizeVersion(version) {
  const numeric = String(version).match(/^\d+(?:\.\d+){0,2}/)?.[0] || '0';
  return numeric.split('.').concat(['0', '0', '0']).slice(0, 3).map(Number).join('.');
}
function hostOS(platform) {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
}
function platformFor(target, architecture, userAgent = '') {
  if (target === 'windows') return 'Win32';
  if (target === 'macos') return 'MacIntel';
  if (target === 'ios') return /iPad/.test(userAgent) ? 'iPad' : 'iPhone';
  if (target === 'android') return 'Linux armv8l';
  return architecture === 'arm' ? 'Linux aarch64' : 'Linux x86_64';
}
function userAgentOS(ua) {
  if (/Android\b/.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Windows NT\b/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  if (/Linux\b/.test(ua)) return 'linux';
  return null;
}
function generateUserAgent(target, version, architecture, chromeVersion, deviceModel = '') {
  const chrome = `Chrome/${chromeVersion}`;
  const iosVersion = version.includes('.') ? version : `${version}.0`;
  if (target === 'ios') return `Mozilla/5.0 (iPhone; CPU iPhone OS ${iosVersion.replaceAll('.', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromeVersion} Mobile/15E148 Safari/604.1`;
  const token = {
    windows: 'Windows NT 10.0; Win64; x64',
    // Current desktop Chromium reduces these legacy UA OS tokens. Actual
    // selected versions and ARM architecture are represented in UA-CH.
    macos: 'Macintosh; Intel Mac OS X 10_15_7',
    linux: architecture === 'arm' ? 'X11; Linux aarch64' : 'X11; Linux x86_64',
    android: `Linux; Android ${version}; ${deviceModel || 'K'}`
  }[target];
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome}${target === 'android' ? ' Mobile' : ''} Safari/537.36`;
}
function androidModel(ua) {
  return (ua.match(/Android \d+(?:\.\d+){0,2};\s*([^;)]+)/)?.[1] || '').replace(/\s+Build\/.*$/, '').trim();
}
function metadataMatches(ua, target, version, architecture, chromeVersion, deviceModel = '') {
  if (target === 'ios' || userAgentOS(ua) !== target) return false;
  const chromeMatch = ua.match(/\bChrome\/(\d+\.\d+\.\d+\.\d+)\b/);
  // A reduced low-entropy UA can keep only the actual major version. Its
  // high-entropy metadata must still use the full running Chromium version.
  const reducedChrome = `${chromeVersion.split('.')[0]}.0.0.0`;
  if (!chromeMatch || ![chromeVersion, reducedChrome].includes(chromeMatch[1])) return false;
  if (/\bMobile\b/.test(ua) !== (target === 'android')) return false;
  if (target === 'windows' && !/Windows NT 10\.0(?:[;)])/.test(ua)) return false;
  if (target === 'macos' && !/Mac OS X 10_15_7(?:[;)])/.test(ua)) return false;
  if (target === 'linux' && !(architecture === 'arm' ? /Linux (?:aarch64|armv8l)/.test(ua) : /Linux x86_64/.test(ua))) return false;
  if (target === 'android') {
    const androidVersion = ua.match(/Android (\d+(?:\.\d+){0,2})\b/);
    const model = androidModel(ua);
    const reducedAndroid = androidVersion && normalizeVersion(androidVersion[1]) === '10.0.0' && model === 'K';
    if (!androidVersion || (!reducedAndroid && normalizeVersion(androidVersion[1]) !== normalizeVersion(version))) return false;
    if (deviceModel && model && model !== 'K' && model !== deviceModel) return false;
  }
  return true;
}
function windowsPlatformVersion(version) {
  if (version === '11') return '13.0.0';
  if (version === '10') return '10.0.0';
  // The Windows kernel still reports 10.0 for Windows 11.
  const parts = String(version).split('.').map(Number);
  return parts[0] === 10 && parts[2] >= 22000 ? '13.0.0' : normalizeVersion(version || '10');
}

/** Build CDP parameters without accessing Electron, a session, or a web page. */
function buildFingerprintConfig(profile = {}, runtime = {}) {
  const p = { ...profile, ...normalizeFingerprintSettings(profile) };
  const rawUA = String(profile.ua ?? '');
  if (rawUA.length > 1024 || /[\x00-\x1f\x7f]/.test(rawUA)) throw Error('User-Agent 无效');
  const customUA = rawUA.trim();
  const host = hostOS(runtime.platform ?? process.platform);
  const hostArchitecture = (runtime.arch ?? process.arch) === 'arm64' ? 'arm' : 'x86';
  const hostVersion = String(runtime.osVersion ?? (typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release()));
  const runtimeUA = String(runtime.userAgent ?? '');
  if (/[\x00-\x1f\x7f]/.test(runtimeUA)) throw Error('浏览器 User-Agent 无效');
  const nativeMode = p.fingerprintMode === 'native';
  const target = nativeMode || p.operatingSystem === 'native' ? host : p.operatingSystem;
  const architecture = nativeMode || p.operatingSystem === 'native' ? hostArchitecture : p.architecture;
  const version = nativeMode || p.operatingSystem === 'native' ? hostVersion : p.osVersion;
  const mobile = !nativeMode && ['android', 'ios'].includes(target);
  const warnings = [];
  const limitations = ['操作系统仅模拟网页可见信息；实际内核、GPU、字体、Canvas/WebGL 和媒体能力仍取决于宿主设备。', '专用 Worker 的 navigator.platform 仍可能显示宿主平台；SharedWorker 和 ServiceWorker 的 UA、平台、语言、CPU 与 UA-CH 也可能保留宿主身份。', '此配置不隐藏自动化接口或开发者工具痕迹。'];
  if (nativeMode) return {
    enabled: false, userAgent: runtimeUA, acceptLanguage: null, userAgentOverride: null, deviceMetrics: null, touchEmulation: null,
    hardwareConcurrency: null, timezone: null, language: null, webRTCPolicy: p.webRTCPolicy,
    summary: { mode: 'native', operatingSystem: host, operatingSystemLabel: OS_NAMES[host], osVersion: hostVersion, architecture: hostArchitecture, deviceModel: '', mobile: false, customUserAgent: false, userAgentMetadataApplied: false, warnings: [], limitations: ['原生模式保留宿主浏览器身份，自定义设备模拟不应用；WebRTC 网络策略仍生效。'] }
  };
  const chromeVersion = String(runtime.chromeVersion ?? process.versions.chrome ?? runtimeUA.match(/\bChrome\/(\d+\.\d+\.\d+\.\d+)/)?.[1] ?? '');
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}\.\d{1,6}$/.test(chromeVersion) && !customUA && !(p.operatingSystem === 'native' && runtimeUA)) throw Error('生成 User-Agent 需要实际 Chromium 内核版本');
  const userAgent = customUA || (p.operatingSystem === 'native' && runtimeUA ? runtimeUA : generateUserAgent(target, version, architecture, chromeVersion, p.deviceModel));
  const detectedOS = userAgentOS(userAgent);
  const navigatorPlatform = platformFor(detectedOS || target, architecture, userAgent);
  let metadataCoherent = /^\d+(?:\.\d+){3}$/.test(chromeVersion) && metadataMatches(userAgent, target, version, architecture, chromeVersion, p.deviceModel);
  // A host's reduced Android UA can report Android 10 for a newer real OS.
  // Explicit targets are checked strictly; native identity remains unchanged.
  if (!customUA && p.operatingSystem === 'native' && target !== 'ios' && detectedOS === target && userAgent.includes(`Chrome/${chromeVersion}`)) metadataCoherent = true;
  const userAgentOverride = { userAgent, acceptLanguage: String(p.language ?? 'zh-CN'), platform: navigatorPlatform };
  if (metadataCoherent) {
    const major = chromeVersion.split('.')[0];
    userAgentOverride.userAgentMetadata = {
      brands: [{ brand: 'Chromium', version: major }], fullVersionList: [{ brand: 'Chromium', version: chromeVersion }], fullVersion: chromeVersion,
      platform: OS_NAMES[target], platformVersion: target === 'windows' ? windowsPlatformVersion(version) : normalizeVersion(version),
      architecture, model: target === 'android' ? p.deviceModel || androidModel(userAgent) : '', mobile, bitness: '64', wow64: false
    };
  }
  if (customUA && !metadataCoherent && target !== 'ios') warnings.push('自定义 User-Agent 与所选系统或实际 Chromium 版本无法完整匹配，已停用 UA-CH 元数据。');
  if (detectedOS && detectedOS !== target) warnings.push('自定义 User-Agent 的操作系统与所选预设不同；触摸和屏幕设置仍按所选预设应用。');
  if (target === 'ios') limitations.unshift('iOS 为浏览兼容模拟；实际引擎仍为 Chromium，并非 iOS WebKit，UA-CH 元数据不发送。');
  if (mobile && p.maxTouchPoints === 0) warnings.push('手机预设关闭了触摸，可能与常见手机环境不一致。');
  if (!mobile && p.maxTouchPoints > 0) warnings.push('桌面预设启用了触摸，请确认符合目标设备。');
  if (p.screenWidth < p.width || p.screenHeight < p.height) warnings.push('屏幕尺寸小于视口，可能产生不一致的屏幕信息。');
  return {
    enabled: true, userAgent, acceptLanguage: userAgentOverride.acceptLanguage, userAgentOverride,
    deviceMetrics: { width: p.width, height: p.height, screenWidth: p.screenWidth, screenHeight: p.screenHeight, deviceScaleFactor: p.deviceScaleFactor, mobile },
    touchEmulation: { enabled: p.maxTouchPoints > 0, ...(p.maxTouchPoints > 0 ? { maxTouchPoints: p.maxTouchPoints } : {}) },
    hardwareConcurrency: p.hardwareConcurrency || null, timezone: String(p.timezone ?? 'Asia/Shanghai'), language: String(p.language ?? 'zh-CN'), webRTCPolicy: p.webRTCPolicy,
    summary: { mode: 'custom', operatingSystem: target, operatingSystemLabel: OS_NAMES[target], osVersion: version, architecture, deviceModel: p.deviceModel, mobile, customUserAgent: !!customUA, userAgentMetadataApplied: !!userAgentOverride.userAgentMetadata, viewport: `${p.width} × ${p.height}`, screen: `${p.screenWidth} × ${p.screenHeight}`, deviceScaleFactor: p.deviceScaleFactor, maxTouchPoints: p.maxTouchPoints, warnings, limitations }
  };
}

module.exports = { FINGERPRINT_PRESETS, DEVICE_PRESETS, WEBRTC_POLICIES, normalizeFingerprintSettings, buildFingerprintConfig };
