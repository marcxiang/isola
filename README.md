# Isola

Isola is an experimental macOS browser built with Electron. It provides isolated browsing environments, proxy configuration, visible AI page control, and a supplier operations workbench.

Isola 是一个基于 Electron 的 macOS 浏览器项目，支持独立浏览器环境、代理配置、可见的 AI 页面控制和货盘运营工作台。

## Project status / 当前状态

The current development version is **0.5.2**. The multi-account operations dashboard, durable photo preparation, native upload verification, account binding and read-only publication checks are integrated. It is a development snapshot, not a completed unattended commerce system.

- Environment management, persistent Chromium sessions, proxy configuration, AI click/scroll feedback, supplier catalog synchronization and listing plans are implemented.
- Listing-field preparation has been exercised on the Vinted France new-item page. Publishing, buyer messages, offers, shipping labels and real supplier purchases have not completed end-to-end validation.
- Supplier photo claims persist their request identity and receipt, download and validate image files, and expose previews in the workbench. Uploads are bound to the current profile and page; uncertain results are checked without selecting the files again. The France new-item page has received the test photo successfully.
- The commerce adapter still blocks unattended business actions. Do not remove this guard merely to make the workflow run.

商品销售分布、账号核验、照片领取、下载、预览与网页上传已接入；真实法国站的 TEST 表单已通过发布前 15 项核对。正式发布、消息、报价、面单及采购流程尚未跑通，不能用于正式无人值守运营。详细接续事项见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## Features / 功能

- Separate persistent Chromium sessions for browsing profiles, with tabs and configuration import/export.
- Native-device mode and configurable user agent, language, timezone and viewport settings.
- HTTP and SOCKS5 proxies, including authentication, connection checks and local SOCKS bridging.
- OpenAI-compatible model configuration, page reading, clicking, typing, keyboard navigation and scrolling, with visible action feedback and pause/stop controls.
- SKU Desk supplier connection, catalog/photo-set synchronization, per-environment listing plans and a durable commerce workflow engine.
- Product-to-account sales distribution, combined filters, per-environment prices and sales targets, verified account names and actual listing receipt links.
- Conservative handling of uncertain external results, purchase limits, bounded read retries, task leases and duplicate-operation prevention.

## Run locally / 本地开发

Use macOS and **Node.js 24** (the locked build dependencies require at least Node.js 22.12.0).

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

The packaging script targets macOS Apple Silicon by default. For an Intel build:

```sh
ISOLA_ARCH=x64 npm run package
```

Intel builds have not been tested on an Intel Mac. Development builds are not Apple Developer ID signed or notarized.

## Data and limits / 数据与边界

- Application data lives in `~/Library/Application Support/Isola/`. Do not commit that directory: it contains browsing sessions, profile configuration and commerce state.
- Stored credentials use Electron `safeStorage`; encrypted values are not a portable cross-machine credential backup. Reconfigure credentials and log in on a new computer.
- The application does not include a modified Chromium engine and does not guarantee undetectable automation or bypass website security checks. Fingerprint diagnostics report observations, not universal pass/fail certification.
- Background work requires the application, its environments, a wakeful computer and network connectivity. Cross-device business-state synchronization and distributed task locking are not implemented.
- Use accounts, product information, photos and workflows that you are authorized to use on the relevant services. Stop for verification or uncertain outcomes.

See [README.txt](README.txt) for the detailed Chinese usage notes and earlier version history.

Isola is an independent project. References to Vinted, SKU Desk and other products identify integration targets; they do not imply affiliation or endorsement.

## License / 许可证

Original project code is available under the [MIT License](LICENSE). Dependencies retain their own licenses. Third-party supplier documentation, proprietary browser packages, personal project notes, credentials and runtime data are not included.
