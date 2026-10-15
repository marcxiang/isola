# Isola

Isola is an experimental macOS and Windows browser built with Electron. It provides isolated browsing environments, proxy configuration, visible AI page control, and a supplier operations workbench.

Isola 是一个基于 Electron 的 macOS / Windows 浏览器项目，支持独立浏览器环境、代理配置、可见的 AI 页面控制和货盘运营工作台。

## Project status / 当前状态

本次开发版在 [`codex/windows-association-v053`](https://github.com/marcxiang/isola/tree/codex/windows-association-v053) 分支与 [草稿 PR #1](https://github.com/marcxiang/isola/pull/1)，尚未合并到 main。接续这版源码请使用该分支。

The current development version is **0.5.3-dev.28**. Listing plans use the selected environment's current signed-in session directly, without account-menu reads, username evidence or member binding. The runtime fills the configured fields, prepares original photos, uploads, submits at most once, and only completes after the original navigation and item receipt are verified. Unknown outcomes stop for reconciliation. This is a **sales-only development build**, not a verified unattended end-to-end marketplace system.

- Starting the scheduler automatically opens a closed listing profile in its original persistent session and uses that session directly for the configured listing. It does not require member binding or read the account menu. Saved homepages are skipped. Closing or stopping that environment holds all its product plans until the interrupted task is reviewed and retried or cancelled.
- Multi-account plans, durable task leases, visible click/scroll feedback and serialized browser actions are integrated. A running AI and the sales runtime cannot control the same account together.
- A paid sale must atomically close the original listing and create a sale-confirmation task before another cycle can start. Deletion, missing pages and accepted offers do not count as paid sales.
- Supplier photo association has a durable outbox. An uncertain request is checked by reading the original claim, never blindly resent. The supplier contract allows only the first listing association; later reuse remains in local history.
- Messages, offer acceptance and paid-sale browser evidence still require live validation and remain disabled. Factual French reply previews and strict evidence validators are implemented, without sending unverified replies.
- Purchase controls are hidden in sales-only mode, purchase tasks cannot run, and no purchase budget is required. Existing purchase history remains intact.
- The original Mac TEST submission and relisting history remain in the original Mac data. Live preparation reached the publication check and stopped before any new publish click because the site had filled an unconfirmed optional material. Clearing that suggestion through the native picker has been checked; live publication and the complete updated automated flow remain unverified.

启动计划后直接使用指定独立窗口的现有登录会话，不再把账号菜单、用户名或会员绑定作为自动上架前置。手动商品与货盘商品共用字段、原图、上传、单次提交和商品回执链路；登录失效或网站要求人工验证时，保留当前任务等待处理。原提交结果未知时仍只核对原请求，不能重新发布。办公室与 Mac 接续请看 [HANDOFF.md](HANDOFF.md)，Windows 使用见 [WINDOWS.md](WINDOWS.md)。

## Mac 真实任务接续与材质诊断 — 0.5.3-dev.28，2026-10-15

真实 dev.27 已通过正常「继续上架」恢复原 TEST 任务、打开原环境并填写八项字段；随后在 `prepare_photos / SECRET_STORAGE_TIMEOUT` 停止。调度已暂停。通过独立照片入口上传并验证原照片 1/1，但自动材质清空仍报告 `original_fields`，未取消选项或点击发布。原任务、照片领取和密钥密文保留，当前刊登版本的提交记录为零；这不是已完成真实上架。

dev.28 将材质失败细分为固定原因，区分原材质控件属性/禁用/值变化、原商品字段节点/值变化，以及原选择节点/状态变化。诊断经白名单传到照片面板，不传任意页面值、错误原文或路径；原节点、字段、包裹、照片和单次发布检查保持。标准 header 已被原适配器排除，不能把普通搜索框重建猜成真实原因；新诊断仍待原网页回读后确定。

完整 Node **1291/1291** 通过，零失败、零跳过。当前源码的隔离完整上架 **5/5** 通过，涵盖原图、可信单次提交、商品回执、不符时保留未知结果及重启防重。新增材质范围桌面测试 **4/4** 在明确的后台就绪模式通过，实际记录 14 次未获得 OS 焦点的操作尝试；原生可信点击、商品原节点/值及包裹保护仍验证。额外要求 OS 前台焦点的夹具三次未就绪记录保留，不宣称其通过；生产输入合同要求真实可见、当前标签及显示就绪，不要求 OS 前台焦点。以上 9 项为隔离静态页面与模拟货盘，不能代替真实刊登。

复现新增桌面测试：`ISOLA_MATERIAL_WATCH_DISPLAY_MODE=background-ready npm run test:electron:focused -- --use-mock-keychain --modules=vinted-material-watch-scope-smoke`。完整链路使用 `--modules=vinted-sales-flow-smoke`。模拟钥匙串仅用于隔离测试进程，生产包不带测试模块或该开关。

系统钥匙串方案按用户选择保留。当前真实货盘密钥读取等待系统授权，桌面工具又连续超时且禁止代操作 SecurityAgent；没有改凭据权限、重建任务或跳过实时库存检查来发布。Mac 新包用于恢复桌面后的接续，不代表本轮真实发布已验证。

## Mac 上架恢复与手机材质选择器 — 0.5.3-dev.27，2026-10-15

真实 dev.26 已完成八项字段和原照片 1/1 上传，但手机材质选择器打开后仍未清空。用隔离原生页面分别复现两个缺陷：选择器自有 header 被误排除，以及长列表达到通用 160 控件上限时，初始 disabled 的 Fait 被降权截掉。旧 helper 在三种布局中都只打开选择器，未取消或提交；不据此断言真实站只存在其中一种原因。

现在可用唯一原生 BUTTON Fait 只读识别选择器，包括其自有 header；实际点击仍要求原按钮已启用并具有最新快照 ID。全局控件上限保持。取消或确认前重新核对完整原生/role 复选框集合、预期选中状态、原标签、分组、标题和按钮节点；新增、漏登记、重用或替换节点均停止。其他商品字段、包裹与发布前检查保持。界面只显示五个已知静态原因和布尔状态，不传任意页面值、错误原文或路径。

还修复“启动调度但原任务不动”：原 listing 在 `publish_listing / PUBLICATION_EVIDENCE_BLOCKED` 停止，旧恢复白名单把它永久排除；`check_optional_fields` 同样遗漏。正常“继续上架”现在仅在原任务身份、周期、版本、去重和照片一致且当前周期/版本完全无提交记录时恢复。同一版本有任何 prepared、cancelled、closed 或已尝试记录都拒绝这项例外；publish 步骤额外要求 session driver、needs_review 和精确错误码。旧版合法已闭合历史保持，原记录、照片及版本不重建；真实商品、库存、照片与单次提交检查重新执行。真实数据库未手动修改。

最终完整 Node 1286/1286 通过，零失败、零跳过；恢复相关 208 项及 adapter 85 项均包含在单元回归中。材质最终源码哈希锁定的桌面关联 8/8 通过：先通过 5 项，余下照片用例因夹具加载后显示尚未就绪而停止，保留失败日志后在夹具等待真实 ready/active/inputVisible，续跑失败及未完成 3 项通过，生产 guard 未放宽。此前候选的新选择器 4 项与原表单 25 项共 29/29 为上一检查点，不重复计入最终 8 项。恢复集成使用真实 sales driver，证明显式开始确实到达开环境、刊登页与字段准备，再受控停止于照片/发布之前。

用户选择保留系统钥匙串保护货盘 API Token，未改存储方案。Mac 目标为 Apple Silicon arm64、macOS 13 起，本机 ad-hoc 签名；dev.27 原 TEST 真实端到端验证将在新构建中继续，尚未认定新商品已发布。

## 已保存资料填写不再读取货盘密钥 — 0.5.3-dev.26，2026-10-15

用户确认系统钥匙串用于保护货盘 API Token 后，选择保留现有保存方式；未接入本机密钥文件、明文或其他替代存储，也未删除原密文或钥匙串条目。设置和错误提示明确这是货盘 API 密钥，避免被理解为 Vinted 额外要求的密钥。

纯手动「填写页面」改为只使用完整确认的计划字段、唯一匹配的缓存商品和有效正整数缓存库存，不读取凭据、创建货盘客户端或领取照片。缺字段、身份歧义、未知/零库存、非 EUR、错误页面，以及检查期间计划、缓存或环境变化均停止；回执明确说明离线准备、未实时核对库存或照片，不能作为发布许可。本地商品路径保持原行为；「核对资料」、真实自动上架和发布前的实时商品、库存、照片检查保持。

完整 Node 1240/1240 通过，零失败、零跳过；新增 Mac 隔离桌面 IPC 2/2 通过，验证真实 beforeFields 恢复并聚焦窗口、原生填写标题和描述时零密钥/货盘调用、零领取/任务/提交，以及实时预检仍在凭据不可用时停止。首次桌面第二项只因错误文案断言沿用旧词失败，修正夹具后通过，初次记录保留；没有放宽生产检查。复现命令：`npm run test:electron:focused -- --use-mock-keychain --modules=commerce-saved-draft-main-smoke`（测试使用临时资料和拦截的静态页面）。

真实 dev.25 曾在原货盘凭据读取的 30 秒上限停止，未进入字段填写；原 TEST 任务、照片与密文保留，调度暂停，无新发布点击。桌面工具明确禁止访问系统 SecurityAgent 授权窗口，不能代操作；需要时由用户本人处理系统授权。dev.26 的原 TEST 现场验证仍在进行，不能把隔离检查当作真实发布结果。

<!-- dev26-live-checkpoint -->

真实 dev.26 已在原 TEST 页面完成八项字段填写：回执明确“未读取货盘 API 密钥”，本次没有钥匙串等待。原照片 1/1 上传并核对，价格 5 欧元、Moyen 与其他字段保持。自动材质清理打开了手机选择器，但 Suggestions/Toutes 的 Plastique 仍选中、Fait 禁用；面板正确单独报告“照片已验证、材质尚未确认清空”。本轮未点击发布、保存草稿或领取新套组，原任务保持待核对。当前优先核查长列表快照截断禁用 Fait 及 picker header 过滤两类结构差异；尚未确认具体原因。当前构建没有 REA 所需的 loopback CDP 端点，未启用新调试端口；实际页面只通过应用现有准备/上传入口与桌面读取验证。

## 上传后的延迟材质建议与独立回执 — 0.5.3-dev.25，2026-10-15

真实 dev.24 已完成原密钥读取、八项字段填写和原照片 1/1 上传，但照片回执成功后页面仍出现 Plastique。照片上传完成不能代表推荐字段也已完成更新；原面板没有独立材质回执，无法把“已清空”和“初读为空”区分开。原任务保持待核对、调度暂停，本轮未保存草稿或点击发布。

首次上传成功后，只有当前应用持有的唯一可选材质输入为空时，才使用单调时钟有界观察最多 5 秒；每次重新读取原文档、字段和材质控件，发现建议即执行原生清空。取消、换页、字段改变、重复/必填/无效材质均停止，观察结束再次核对包裹与字段。直接清理的默认行为不变；重新核对上传仍只读，不清空或再次上传。5 秒观察不是保证网站此后不再变化，原发布前核对保持，晚到的不一致仍阻止发布。

照片 IPC 仅增加 verified/cleared/unchanged 三个显式布尔材质结果；面板分别显示已清空、暂未发现、失败或待核对，照片成功不再被当成材质完成。未知字段、路径和原始材质错误不传给面板。

完整 Node 1233/1233 通过，零失败、零跳过；本轮 4 项相关原生专项通过（保留先通过 1 项，续跑失败及未完成 3 项，未重跑其余 21 项）。新增 fixture 在原图已加载、照片回执成功且 helper 首读材质为空后，约 902ms 才注入建议，生产 wrapper 自动清空，价格、Moyen、其他字段与原图保持，发布次数 0；只读重新核对不清空、点击或重传。两次新 fixture 的函数序列化失败记录保留，修正夹具后通过，未放宽生产检查。以上为隔离测试，真实现场仍待验证。dev.24 的 25 项原生表单及 dev.23 的其他专项为历史检查点，不重复计数。

## 同额欧元格式与材质清空 — 0.5.3-dev.24，2026-10-15

Mac dev.23 已在真实页面成功读取原货盘密钥、填写八项商品字段并上传原照片 1/1，没有再次卡在钥匙串；调度保持暂停，未保存草稿或点击发布。真实清空仍在操作前被阻止，随后用实际 prepareFields 复现：价格所有权回执为「5,00」，网页失焦后显示「5,00 €」，逐字符串比较错误地抛出 EXISTING_DRAFT。

现在仅在清空前核对价格时，允许严格解析为相同正整数欧分的逗号、点及可选欧元符号格式；不能接受改价、其他币种、非法金额或模糊小数。原所有权记录不改，进入清理后原节点和值仍逐字符串锁定，其他字段及包裹核验保持。出错提示显示静态字段名称，不输出页面值或未知标签。

完整 Node 1220/1220 通过，零失败、零跳过；Mac 原生表单 25/25 通过。新增用例实际填写价格并保持原所有权回执，原生失焦后补上欧元符号，再经生产原图上传及材质清空，保留准确金额、其他字段、Moyen 与已加载原图，发布次数为 0。首次新增 fixture 因照片说明缺少法语撇号而未满足严格照片回执，已修正夹具并保留首次失败记录；未改生产回执规则。以上为隔离资料和本地页面；真实新版自动清空及发布仍待验证。dev.23 的 66 项隔离专项属于上一检查点，不重复计入本轮。

## 货盘密钥异步读取 — 0.5.3-dev.23，2026-10-15

真实 Mac dev.22 在“填写页面”的货盘预检读取已保存 API 密钥时卡住；主线程采样停在同步 Security/钥匙串调用中，用户及桌面检查均没有看到系统授权提示。只确认系统调用正在等待，不能据此断言登录钥匙串被锁定。原 TEST 保持待核对，未新增发布尝试，原照片和记录已在本机私有备份。

货盘连接、同步、字段预检、照片、发布前核对及关联服务现统一等待原生异步密钥接口，读取、比较与保存密钥均有 30 秒上限。超时或取消后不创建客户端、不继续原步骤、不保存迟到密文；等待期间的存储故障同样停止，保存失败回滚原密文和商品资料。真实商品身份、库存及原图的实时检查保持，未改为离线放行。系统钥匙串操作本身不能由此取消，也没有更改访问权限或明文回退。

完整 Node 1217/1217 通过，零失败、零跳过；隔离 Mac 桌面 52/52（货盘工作台 12、表单与材质 24、发布证据及提交 11、完整上架流程 5）通过。另用独立临时资料及 test-only mock keychain 验证原生密钥接口 14/14：旧同步与新异步密文双向兼容，服务不可用时拒绝操作，界面事件循环继续运行。以上 66 项桌面/原生专项不是完整默认 Electron 套件，也不能代替真实钥匙串许可或真实 Vinted 发布。首次 Node 测试有 5 项本地监听被沙箱拒绝，保留日志；允许本地测试服务后完成最终检查。

本次只迁移货盘凭据；账号库、代理及启动 AI 的独立同步密钥路径尚未迁移。系统服务曾拒绝访问时，当前进程可能需要正常重启后再申请许可；保留原密文，不能通过删除密钥或重建任务解决。Electron 对一致签名的说明见 [safeStorage 文档](https://www.electronjs.org/docs/latest/api/safe-storage)。Mac dev.22 的 arm64 包已经完成打包、ad-hoc 签名和压缩包检查；dev.23 将使用同一 macOS 13 起的 Apple Silicon 目标。新版真实页面的自动清空及真实发布仍待验证。

## 上传后清空未确认的可选材质 — 0.5.3-dev.22

Mac dev.21 真实上架准备已核对八项字段、Moyen 包裹和原照片 1/1；发布前因可选「Matériau (recommandé)」出现未经确认的 Plastique 建议值而停止。重新准备时材质为空，上传同一张原照片后网站再次自动填入该建议。用户明确选择清空，不填写材质；该建议值不作为商品事实保存。

本版在上传完成后、发布证据核对前，通过当前应用持有的草稿执行专用可选材质清空：核对唯一可选材质输入和手机选择器，只取消已核对的唯一选中项，原生点击 Fait，再回读原字段为空。其他未知字段、必填材质、多选、重复控件、错误选择器范围或回读失败继续停止。八项字段、照片、价格、包裹及单次提交约束保持。

阻止原因改为具体可处理提示，例如「可选材质已填入但未在计划确认」；其他未知字段、错误、页面状态和弹窗仅显示静态字段名、标志和数量，不写出未知字段值、标签或提示全文。真实页面已通过原生选择器清空建议，原照片和 Moyen 保持；本轮没有点击发布，也尚未认定更新后的完整自动流程通过真实网页验证。

<!-- dev22-validation -->

dev.22 验证：完整 Node 1194/1194 通过，零失败、零跳过；Mac 原生表单 24/24、发布证据与提交 11/11、完整本地上架流程 5/5，共 40 项桌面专项通过，不是完整默认 Electron 套件。手机流程 fixture 在上传后自动填入 Plastique，生产 runtime 通过原生点击取消 Toutes 镜像，等待延迟同步为空并点击 Fait，随后才单次发布；原图、商品回执与重启防重保持。首次材质专项因快照中的字符串 `invalid='false'` 被当作真而停止，已显式解析并保留失败日志；只读重新核对不清空材质，并有单元覆盖。以上使用隔离资料和本地页面，真实网站目前仅验证了原生手动清空，新自动清空方法及真实发布尚待现场验证。Mac 构建目标为 Apple Silicon（arm64）、macOS 13 起；下方 dev.21 的构建与测试结果属于前一版本。

## macOS 同步 Windows 开发进度 — 0.5.3-dev.21

本版将 Windows dev.11–20 已有功能同步到 Mac：自己添加商品和本地照片、商品卡片与封面、WebP 展示图转换、已使用货盘原图的手动复用、已删除计划恢复、继续原任务，以及直接使用独立窗口会话自动上架。商品资料是新计划的独立快照；仅查看封面不会领取上架图片，恢复计划不会自行发布。此前各版本的 Windows 验证和历史实现保留在下方。

修复 macOS `/var` 与 `/private/var` 指向同一目录时，本地商品及货盘 prepared 照片被误判为路径异常的问题。应用先规范化私有根目录，并核对真实目录的设备号和 inode；应用自管子目录和照片的符号链接仍拒绝，上传路径、JPEG 内容与哈希核验保持。首次 Mac 本地完整上架检查在货盘照片路径复现同一问题后修正，保留失败记录。

本轮 Mac 已验证：完整 Node 1181/1181、照片目录相关专项 129/129、Electron 账号专项 54/54、工作台专项 114/114、商品与上架专项 32/32 通过，合计 200 个不同桌面检查；这不是完整默认 Electron 套件。工作台旧账号前置和状态文案夹具按新版会话流程适配后完成，未重跑已通过模块，初次失败记录保留。隔离手机 DOM fixture 没有账号菜单、用户名或会员绑定，账号读取为零，仍通过原图上传、一次提交、商品回执与重启防重。测试使用独立资料与本地页面；尚不能据此认定真实 Vinted 发布或完整无人值守流程已跑通。Mac 构建目标为 Apple Silicon（arm64）、macOS 13 起，本地 ad-hoc 签名；Intel 版此轮不构建。

## 自动上架直接使用环境会话 — 0.5.3-dev.20

按用户要求取消自动上架中的账号核对前置。开启计划直接使用指定独立环境的现有登录会话，进入 `/items/new`，填写商品、准备原图、上传、发布并读取原提交的商品回执。自动链路完全不打开账号菜单或 Profil，不读取用户名，不要求会员绑定，也不会创建假的会员身份。环境列表显示「使用当前窗口会话」。若网站要求登录或人工验证，留在当前窗口处理。

旧账号核对失败的确定未提交任务可以直接继续，保持原任务、去重编号、照片和资料。商品字段先于照片领取处理，失败显示具体字段原因。单次提交、原页面/环境/计划约束、提交结果未知停止与重启去重保留；回执关联固定到原提交跳转、商品、价格、原图摘要和本人管理控件。新会话记录可核对原刊登结果或确认已删除，不重新要求账号绑定；历史会员证明保持兼容。

验证：Node 1178 项通过、零失败、1 项 Windows 不适用检查跳过；隔离 Electron 完整上架 5/5。Pixel 7 测试页面没有账号菜单、用户名或会员链接，所有账号读取方法强制报错，仍完成字段、原图上传、一次发布、DOM 回执和重启防重；账号读取 0 次、Profil 点击 0 次、未创建账号绑定。打包 Windows EXE 检查通过，确认 sessionListing 开启且不要求 autoBindAccount，依赖审计为 0。首次 Node 检查的两个新删除夹具补齐原持久跳转证据后通过，保留初次失败日志。以上是本地测试；真实 Vinted 发布、完整桌面回归和新 Mac 包未在本轮验证。

## 修复手机上架前中断与重复开页 — 0.5.3-dev.19

现场确认已登录的手机环境可打开 `/items/new` 并显示照片、标题、描述、分类和价格表单。原任务实际停在 `check_catalog`，尚未进入照片或刊登准备：原生点击 Profil 后，网页对同一会员地址连续执行 `pushState`、`replaceState`，旧导航校验误判后一次页面内更新，导致账号读取中断、不断重试并新增标签。

现仅允许原生点击已确认地址后的同地址页面内更新；其他会员、未知地址、跨站与重复完整导航继续停止。保留两次菜单读取、本人主页姓名与会员编号比对及菜单闭合核验。内部读取中断与真正的用户取消分别处理：前者暂停原任务并显示具体原因，明确再次开始可恢复同一未提交任务，保留编号、去重记录、图片和资料；不会继续自动开页。已提交或结果未知的记录仍核对原请求。

<!-- dev19-validation -->

dev.19 验证：Node 1147 项通过、零失败、1 项 Windows 不适用检查跳过；隔离 Electron 手机身份 6/6、完整上架链路 5/5。Pixel 7 原生 Profil 同地址 pushState → replaceState → 异步本人标题 → 严格闭合菜单通过；其他会员、未知地址、跨站及重复完整导航四类原生负例均停止。完整手机流程从无绑定开始，完成字段、原图上传、一次发布、DOM 回执与重启防重；首次集成测试因窗口被最小化在上传前停止，保留失败日志后以同一生产源码显式复测通过。打包 Windows EXE 检查及依赖审计通过。现场只确认旧版手机环境能进入真实刊登表单，未据此宣称真实发布成功；完整桌面回归与新 Mac 包未在本轮完成。

## 自动上架去除手动核对与 WebP 展示图 — 0.5.3-dev.18

取消账号页、计划页的手动「核对登录／核对账号」按钮、弹窗与前置要求。直接登录固定窗口、填好商品资料并开启计划，首次执行自动读取当前本人身份，将运营账号和原任务一起保存后继续照片、表单与单次发布；手机环境通过原生 Menu → Profil → 本人主页读取身份。既有账号及刊登历史仍固定到原身份，验证码或登录失效交由当前窗口处理，不会凭邮箱猜账号或重复提交未知刊登。

实际货盘图片返回 WebP，Windows nativeImage 无法解码，现改用独立、隐藏且禁止联网的沙箱图片解码器生成 JPEG 缩略图；正常 PNG/JPEG 保留原路径。缩略图失败提供「重试展示图」，取消或超时关闭解码窗口。已对本机现有 19 件货盘商品执行只读封面请求，19/19 转换成功，不领取或使用上架图库。

dev.18 验证：Node 1136 项通过、零失败、1 项 Windows 不适用权限检查跳过；工作台 114/114、账号 52/52、上架 32/32。Pixel 7 手机完整本地链路从无绑定开始，经原生 Profil 点击、商品填写、原图上传、一次发布、真实 DOM 回执及重启防重检查通过；打包 Windows EXE 通过 WebP 封面转换和取消手动核对入口检查。旧测试中的手动核对前置、状态文案和跨标签点击审计已调整，失败日志保留，修复后只完成失败或未完成模块；无自动重试测试。依赖审计为 0。真实货盘展示图只读转换 19/19 通过；真实 Vinted 发布、完整桌面回归及新 Mac 包未在本轮完成。

## 操作松绑与原任务继续 — 0.5.3-dev.17

账号名称、邮箱和密码可以在后台调度期间、窗口打开时保存；同账号正在登录或核对时等待该步骤完成。删除移除本机登录资料和保存密码，保留网页会话、原运营身份、计划与任务。尚未核验的账号即使已有草稿计划，也可删除本机资料；已验证身份如仅存在账号库且缺少完整运营绑定，需先核对以保留原身份。修改凭据继续保留未知登录结果的待核对状态。

计划中的「继续上架」显式恢复当前周期尚未提交的原任务，沿用原编号、去重键和照片，不必先跑到任务页取消或重新创建。其他环境的运行任务不再挡住本环境的安全编辑及重试。仅保存已启用计划的资料保持原启用状态；只有这次勾选保存后开始，才立即启动。已提交、原结果未知、在售或错绑定的记录继续核对原请求。

核对登录优先使用当前 Vinted 页面，手机核验先恢复显示窗口、等待页面与设备显示就绪后再读取；加载未完成、窗口不可操作、环境忙等分别显示原因。本轮未完成真实 Vinted 核对或发布，现场旧版仅成功读取状态，原生界面输入返回不可操作窗口错误。

dev.17 Windows 验证：Node 1112 项通过、零失败，1 项 POSIX 权限检查在 Windows 跳过；工作台 110/110、账号 52/52、商品与上架 32/32。各 Electron 模块使用独立临时数据与新进程、默认沙箱，无自动重跑。打包 EXE 已验证打开环境时新建和编辑本机账号、删除本机资料后保留原计划任务与网页环境，并验证商品卡片、环境表格和加密账号存储。首次账号界面测试因删除按钮改名调整定位后通过；依赖审计为 0。真实 Vinted 登录核对和发布、完整桌面回归及新 Mac 包均未在本轮完成。

## 计划删除恢复、环境表格与我的商品 — 0.5.3-dev.16

有确定未提交任务或已关闭历史的计划可移到「已删除计划」。应用原子停用计划，取消未提交排队任务，保留原计划、任务、照片及去重编号。进入同一环境的「已删除计划」可恢复，恢复后保持停用，不会自动重排或重发。仍在售、提交结果未知、照片领取未明或有待完成成交／履约时，继续显示具体原因并保留当前计划。无业务记录草稿仍可直接删除。

自动化环境改为与环境管理一致的表格，按行显示设备、窗口状态、Vinted 登录状态、当前计划与任务状态，账号与计划仍在同一工作台。商品页更名「我的商品」：卡片和详情显示货盘返回的商品展示图，上架图片库默认收起并由后台流程管理，保留详情中的手动复用入口。仅浏览展示图不领取照片、不产生使用记录，未提供或无法读取展示图时显示占位。升级后同步货盘可获取新的展示图字段。

<!-- dev16-validation -->

dev.16 Windows 专项验证：Node 1068 项通过、零失败、1 项 Windows 不适用检查跳过；工作台与归档/展示图 102/102、账号 43/43、商品与自动上架 32/32。每个 Electron 模块使用独立临时数据及新进程，默认沙箱开启，无自动重跑；旧图片库测试先适配折叠导航，再依据隐藏视图 close 事件未派发的诊断，仅在隔离测试关闭并恢复后台节流，生产计时策略保持。打包 EXE 验证表格、我的商品、受限展示图与折叠库、恢复接口、草稿删除、独立计划快照及加密账号存储；依赖审计为 0。真实 Vinted 核对或发布未在本轮执行，完整桌面回归未宣称通过，新 Mac 包未构建。

## 自动化环境运营与商品卡片 — 0.5.3-dev.15

自动化环境成为账号与上架计划的共同入口。环境列表中点击「账号与计划」，或在运营侧栏选择「自动化环境」，进入具体环境后切换「账号与登录」「商品与上架计划」，查看本环境任务。新账号与计划固定到当前环境；刷新或切换工作台页面保留已选环境。既有普通环境的关联记录仍可访问，新计划先选择自动化用途环境。

商品与图片改为商品卡片，库存、价格和照片数量随商品展示，图片套组只放在对应商品详情中；详情继续支持已使用照片手动复用。删除入口支持尚无业务记录的计划与未被引用的手动商品，确认失败保留具体原因。已有任务、领取、在售、原提交或成交记录不能删除，需停用并保留历史；删除草稿不操作平台商品或货盘。

修正核对失败被旧「上次登录过程已中断」覆盖的问题：本次开窗和核对失败会保存当前原因，旧登录结果待核对由独立持久标记保留；成功读取真实账号后原子清除。失败不代表已登录，也不会自动重复提交旧登录。真实 Vinted 仍待同版本现场验证。

<!-- dev15-validation -->

dev.15 Windows 专项验证：Node 931 项通过、零失败、1 项 Windows 不适用检查跳过；环境工作台与商品/删除界面 83/83、账号 43/43、商品与自动上架 32/32。各桌面模块使用独立临时数据和新的 Electron 进程，默认沙箱开启；修正测试导航时序与状态污染后最终组全部通过，无自动重跑。另一次上架专项因测试窗口被最小化而安全停止，保留该失败记录后另行复测通过。打包 EXE 验证环境内账号、商品卡片与详情、有关联商品拒绝删除、草稿删除、计划快照、设备参数及加密账号存储；依赖审计为 0。真实 Vinted 核对或发布未在本轮完成，完整桌面回归仍不以专项替代，新 Mac 包未构建。

## 手机 Profil 核对与已用照片复用 — 0.5.3-dev.14

手机版账号核对现在会在独立核验标签中实际点击「Profil / Mon profil」进入本人主页，再读取用户名与账号身份；已有绑定也走该手机流程。原操作标签和草稿保留，确认失败不会保存为已核验。

在「商品与图片」选择货盘套组的「手动复用」，已使用套组也可选择。应用重新读取原图并生成本地副本，带入商品资料与已保存的建议售价；审阅后保存为独立手动商品，再创建计划。原货盘商品、占用与使用记录保留，副本库存和资料由用户维护。货盘不提供原图或拒绝下载时会说明原因，不能把缩略图或失败下载当作已导入。

<!-- dev14-validation -->

dev.14 Windows 专项验证：Node 865 项通过、零失败、1 项 Windows 不适用检查跳过；商品与自动上架 32/32、账号核对 42/42。包含已使用套组读取、拒绝原图权限、独立手动商品保存，以及首次和再次手机 Profil 原生点击核验。桌面各模块使用独立临时数据和新的 Electron 进程，默认沙箱开启，不自动重跑失败项；打包 EXE 启动、复用接口、商品来源、计划预检、设备参数和加密账号存储检查通过，依赖审计为 0。以上为本地测试，真实 Vinted 核对和发布仍待同版本现场验证；完整桌面回归未完成通过，新 Mac 包未构建。

## 手动商品与启用即执行 — 0.5.3-dev.13

商品页现在可以「自己添加商品」，填写商品资料、库存和售价，并通过本机选择器导入 1–20 张照片；这条来源不需要货盘 Token。货盘同步和手动商品分开保存。新计划沿用商品资料后成为独立快照。

在「连接与规则」允许后台执行，固定环境的账号完成绑定后，点击计划「启用并开始」或保存时勾选「保存后立即开始上架」，即检查条件并启动该计划。条件不满足会拒绝启用并显示原因，不会顺带启动其他未明确开始的计划；已有的全局调度继续按其原范围运行。后台任务仍会核对实时账号、页面、照片和回执。

修正核对登录请求返回但身份未通过时弹窗误关闭的问题。核对失败会保留弹窗与原因；计划核对也保留当前结果。首次手机邮箱账号绑定，在操作员明确确认后使用独立核验标签读取本人主页；主页链接候选本身不算身份核验。真实现场核对与真实自动上架仍待同版本验证。

<!-- dev13-validation -->

dev.13 Windows 专项验证：Node 813 项通过、零失败、1 项 Windows 不适用检查跳过；商品与自动上架 26/26、账号核对 42/42。桌面专项各模块使用独立临时数据和新的 Electron 进程，默认沙箱开启，不自动重跑失败项。打包 EXE 的手动商品、来源派发、启用预检、计划快照、设备参数与加密账号存储通过；依赖审计为 0。完整 Electron 桌面回归尚未完成通过，旧整套测试仍有窗口交互问题；不能将专项通过当作整套通过。没有真实 Vinted 登录／发布验证，也未构建新版 Mac 包。

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

The packaging script targets the current OS (macOS defaults to Apple Silicon; Windows defaults to x64). The latest 0.5.3-dev.25 source currently lives on `codex/windows-association-v053`, while `main` remains at the earlier checkpoint. Check out the development branch before building the latest version.

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
