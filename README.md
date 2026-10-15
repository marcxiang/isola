# Isola

Isola is an experimental macOS and Windows browser built with Electron. It provides isolated browsing environments, proxy configuration, visible AI page control, and a supplier operations workbench.

Isola 是一个基于 Electron 的 macOS / Windows 浏览器项目，支持独立浏览器环境、代理配置、可见的 AI 页面控制和货盘运营工作台。

## Project status / 当前状态

本次开发版在 [`codex/windows-association-v053`](https://github.com/marcxiang/isola/tree/codex/windows-association-v053) 分支与 [草稿 PR #1](https://github.com/marcxiang/isola/pull/1)，尚未合并到 main。接续这版源码请使用该分支。

The current development version is **0.5.3-dev.12**. The production runtime now connects background listing preparation to the existing guarded single-submit publisher. It checks account and catalog identity, prepares the original photos, fills confirmed fields, uploads, submits at most once, and only completes after an attributed item receipt is verified. Unknown outcomes stop for reconciliation. This is a **sales-only development build**, not a verified unattended end-to-end marketplace system.

- Starting the scheduler automatically opens a closed listing profile in its original persistent session, then checks the current account before preparing photos or publishing. Saved homepages are skipped. Closing or stopping that environment holds all its product plans until the interrupted task is reviewed and retried or cancelled.
- Multi-account plans, durable task leases, visible click/scroll feedback and serialized browser actions are integrated. A running AI and the sales runtime cannot control the same account together.
- A paid sale must atomically close the original listing and create a sale-confirmation task before another cycle can start. Deletion, missing pages and accepted offers do not count as paid sales.
- Supplier photo association has a durable outbox. An uncertain request is checked by reading the original claim, never blindly resent. The supplier contract allows only the first listing association; later reuse remains in local history.
- Messages, offer acceptance and paid-sale browser evidence still require live validation and remain disabled. Factual French reply previews and strict evidence validators are implemented, without sending unverified replies.
- Purchase controls are hidden in sales-only mode, purchase tasks cannot run, and no purchase budget is required. Existing purchase history remains intact.
- The earlier TEST submission is retained with an operator-confirmed deletion record. Its revision 1 relisting task is held for review at the catalog check, at €5 with zero completed sales and the original photos preserved. Automatic profile opening has been observed live; mobile account-menu closure still needs correction. No new publication has been completed.

启动调度后，已绑定账号的上架计划会自动打开对应环境，无需逐个手动开窗。后台刊登链路已接入，逐项核对不通过就暂停；消息、报价、成交和卖出后补上仍待真实页面联调。已删除且未售出的原商品可在暂停调度后选择“已删除，重新上架”，填写原商品地址并确认；保留原提交、销量和图片，创建独立的重上架任务。办公室接续请看 [HANDOFF.md](HANDOFF.md)，Windows 使用见 [WINDOWS.md](WINDOWS.md)。

dev.10 源码接续检查点（2026-10-15）：最终完整 Node 729/729 通过，零失败、零跳过，包含 AI 延迟解密修复；AI 与设置存储专项 18/18 通过。较早轮次 Mac Electron 联合检查 80/80 通过，嵌套标题处理、关闭菜单诊断和延迟解密修复尚未重新完成同组桌面回归。

用户启动后已实际自动打开账号衣橱，自动开窗时的会话刷新竞态已修复；header 外独立手机菜单的原生连续性专项 12 项通过。真实账号菜单已两次读取并点击关闭，但闭合核验仍失败，正在依据本机脱敏诊断处理。分类、品牌、成色、颜色四类 Fait 收尾源码已修；真实自动仅分类和品牌通过，其余仍待实测。较早在手工完成 Fait 后，旧构建应用已核对八项商品字段和原一张照片上传回执，不代表全自动准备已通过。没有新发布；revision 1 原任务停在 needs_review / check_catalog，售价 5 欧元、销量 0、照片保留。

已定位并修复一处开窗卡住的原因：隐藏的 AI 面板也会读取模型设置并同步解密密钥，等待系统钥匙串时阻塞主线程。现在读取模型元信息和普通设置保存均保留密文，真正启动 AI 时才解密；新密钥加密、清除及更换接口地址的密钥规则保持。新包尚待真实开窗验证；代理和货盘等其他凭据访问仍可能需要钥匙串许可。

本次先保存源码进度，未交付包含全部最新修复的最终 Mac 包。下次办公室先恢复仍等待系统钥匙串的旧应用，再打包最新源码、复测账号菜单关闭诊断和四类 Fait，重跑桌面回归后继续原任务；当前未完成全自动刊登。

## Features / 功能

- Separate persistent Chromium sessions for browsing profiles, with tabs and configuration import/export.
- One main window for environment management and commerce, with a full-page environment editor, collapsible operations navigation, separate normal/automation profile lists, recorded Vinted verification and live task status, and per-environment encrypted model settings.
- Fixed custom-device viewports with proportional display when the outer window resizes; screen, DPR, touch and device identity remain configured independently of the host window.
- An encrypted Vinted account center with fixed profile bindings, dedicated one-attempt email/password login, verified account-menu receipts and manual handoff for security challenges. Real-account authentication still requires live validation.
- Native-device mode and configurable user agent, language, timezone and viewport settings.
- HTTP and SOCKS5 proxies, including authentication, connection checks and local SOCKS bridging.
- OpenAI-compatible model configuration, page reading, clicking, typing, keyboard navigation and scrolling, with visible action feedback and pause/stop controls.
- SKU Desk supplier connection, catalog/photo-set synchronization, per-environment listing plans and a durable commerce workflow engine.
- Product-to-account sales distribution, combined filters, per-environment prices and sales targets, verified account names and actual listing receipt links.
- Conservative handling of uncertain external results, bounded read retries, task leases and duplicate-operation prevention.

## Device profiles / 设备与手机模拟

Environment creation now supports Windows, macOS, Linux, Android and iOS browser compatibility profiles. Choose a Pixel 7, Galaxy S23, iPhone 13 or iPhone 14 Pro preset, then adjust the OS version, model, viewport, logical screen size, DPR, touch points, CPU, language, timezone and WebRTC policy. The preview shows generated UA and effective limits before saving. Profiles keep their settings across restarts and configuration copies.

The local device check reports actual automation signals, page/Worker/iframe differences, mobile input/orientation, GPU, repeated Canvas and offline audio stability. It does not certify a human-operated or undetectable phone: the engine, GPU, fonts and media stack remain those of the host. Dedicated Worker platform and Shared/Service Worker identity may still reflect the host. iOS profiles retain Chromium rather than WebKit. See [DEVICE_PROFILES.md](DEVICE_PROFILES.md).

## Run locally / 本地开发

Use macOS or Windows and **Node.js 24**.

```sh
git clone --branch codex/windows-association-v053 https://github.com/marcxiang/isola.git
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

The packaging script targets the current OS (macOS defaults to Apple Silicon; Windows defaults to x64). The latest 0.5.3-dev.12 source currently lives on `codex/windows-association-v053`, while `main` remains at the earlier checkpoint. Check out the development branch before building the latest version.

For a local Apple Silicon development build on macOS 13 or later:

```sh
git switch codex/windows-association-v053
npm ci
npm run package -- --platform=darwin --arch=arm64
codesign --force --deep --sign - dist/Isola-darwin-arm64/Isola.app
codesign --verify --deep --strict dist/Isola-darwin-arm64/Isola.app
```

The last two commands apply and verify a local ad-hoc signature. They do not provide Developer ID signing or Apple notarization. Do not modify `app.asar` or its integrity metadata after packaging; Electron 44 validates the embedded digest. Before running tests on a fresh install, initialize the lazy runtime once with `node -e "require('electron')"`; do not start the first build and tests concurrently.

Windows:

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
