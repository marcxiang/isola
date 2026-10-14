# Isola

Isola is an experimental macOS and Windows browser built with Electron. It provides isolated browsing environments, proxy configuration, visible AI page control, and a supplier operations workbench.

Isola 是一个基于 Electron 的 macOS / Windows 浏览器项目，支持独立浏览器环境、代理配置、可见的 AI 页面控制和货盘运营工作台。

## Project status / 当前状态

The current development version is **0.5.3-dev.3**. The multi-account operations dashboard, durable photo preparation, native upload verification, account binding and publication checks are integrated. A guarded manual publication step records one attempt before clicking; an uncertain result blocks another submission. One real test item was published at €5 using 0.5.2. Operator-reviewed receipt association is now connected through the main process, with expiring single-use capabilities, a fresh detail read and one full database commit. It still requires matching photo evidence and live validation. It is not a completed unattended commerce system.

- Environment management, persistent Chromium sessions, proxy configuration, AI click/scroll feedback, supplier catalog synchronization and listing plans are implemented.
- Listing fields, photo upload and one guarded manual publication have been exercised on Vinted France. The live item was checked visually; application receipt association, buyer messages, offers, shipping labels and real supplier purchases still need end-to-end validation.
- Supplier photo claims persist their request identity and receipt, download and validate image files, and expose previews in the workbench. Uploads are bound to the current profile and page; uncertain results are checked without selecting the files again. The France new-item page has received the test photo successfully.
- The commerce adapter still blocks unattended business actions. Do not remove this guard merely to make the workflow run.

商品销售分布、账号核验和照片流程已接入；真实法国站 TEST 商品已按 5 欧元成功发布一次。原刊登关联后端现已接通，但原电脑的 TEST 状态仍待现场核对，禁止重复发布。消息、报价、面单及采购流程尚未跑通。办公室请先看 [HANDOFF.md](HANDOFF.md)，Windows 使用见 [WINDOWS.md](WINDOWS.md)。

## Features / 功能

- Separate persistent Chromium sessions for browsing profiles, with tabs and configuration import/export.
- Native-device mode and configurable user agent, language, timezone and viewport settings.
- HTTP and SOCKS5 proxies, including authentication, connection checks and local SOCKS bridging.
- OpenAI-compatible model configuration, page reading, clicking, typing, keyboard navigation and scrolling, with visible action feedback and pause/stop controls.
- SKU Desk supplier connection, catalog/photo-set synchronization, per-environment listing plans and a durable commerce workflow engine.
- Product-to-account sales distribution, combined filters, per-environment prices and sales targets, verified account names and actual listing receipt links.
- Conservative handling of uncertain external results, purchase limits, bounded read retries, task leases and duplicate-operation prevention.

## Device profiles / 设备与手机模拟

Environment creation now supports Windows, macOS, Linux, Android and iOS browser compatibility profiles. Choose a Pixel 7, Galaxy S23, iPhone 13 or iPhone 14 Pro preset, then adjust the OS version, model, viewport, logical screen size, DPR, touch points, CPU, language, timezone and WebRTC policy. The preview shows generated UA and effective limits before saving. Profiles keep their settings across restarts and configuration copies.

The local device check reports actual automation signals, page/Worker/iframe differences, mobile input/orientation, GPU, repeated Canvas and offline audio stability. It does not certify a human-operated or undetectable phone: the engine, GPU, fonts and media stack remain those of the host. Dedicated Worker platform and Shared/Service Worker identity may still reflect the host. iOS profiles retain Chromium rather than WebKit. See [DEVICE_PROFILES.md](DEVICE_PROFILES.md).

## Run locally / 本地开发

Use macOS or Windows and **Node.js 24**.

```sh
git clone https://github.com/marcxiang/isola.git
cd isola
npm ci
npm start
```

Configure model and supplier credentials inside the application. No API credentials or browser sessions are bundled with the source.

## Tests / 测试

```sh
npm test
node --test test/vinted-photo-upload.cjs
npm run test:electron
```

Electron tests require a desktop session; network tests start local servers. The desktop suite includes photo service, native file-input transport, repeated proxy authentication and environment storage isolation checks. Unit coverage includes interrupted photo claims, retained idempotency keys, file validation and ambiguous upload recovery. Mock and fixture results do not establish that a live marketplace transaction works.

## Build / 构建

```sh
npm run package
```

The packaging script targets the current OS (macOS defaults to Apple Silicon; Windows defaults to x64). Windows:

```sh
npm run package:windows
```

The portable Windows folder is `dist/Isola-win32-x64`. Extract the entire distributed ZIP, then open `Isola.exe`; keep its DLLs and resource folders together. See [WINDOWS.md](WINDOWS.md). For an Intel Mac build:

```sh
ISOLA_ARCH=x64 npm run package
```

Intel builds have not been tested on an Intel Mac. Development builds are not Apple Developer ID signed or notarized.

## Data and limits / 数据与边界

- Application data lives in `~/Library/Application Support/Isola/` on macOS and `%APPDATA%\Isola\` on Windows. Do not commit that directory: it contains browsing sessions, profile configuration and commerce state. Windows photo files inherit the user-data directory ACL; POSIX mode bits are checked only on POSIX systems. Both platforms verify file type, link identity and JPEG hashes.
- Stored credentials use Electron `safeStorage`; encrypted values are not a portable cross-machine credential backup. Reconfigure credentials and log in on a new computer.
- The application does not include a modified Chromium engine and does not guarantee undetectable automation or bypass website security checks. Fingerprint diagnostics report observations, not universal pass/fail certification.
- Background work requires the application, its environments, a wakeful computer and network connectivity. Cross-device business-state synchronization and distributed task locking are not implemented.
- Use accounts, product information, photos and workflows that you are authorized to use on the relevant services. Stop for verification or uncertain outcomes.

See [README.txt](README.txt) for the detailed Chinese usage notes and earlier version history.

Isola is an independent project. References to Vinted, SKU Desk and other products identify integration targets; they do not imply affiliation or endorsement.

## License / 许可证

Original project code is available under the [MIT License](LICENSE). Dependencies retain their own licenses. Third-party supplier documentation, proprietary browser packages, personal project notes, credentials and runtime data are not included.
