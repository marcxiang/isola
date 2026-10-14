# 办公室开发接续

保存日期：2026-10-14。源码版本：**0.5.3-dev.1**。这是保存未完成开发工作的接续版本；实际完成 TEST 发布的应用包是 0.5.2。

## 现在做到哪里

- 已实现 macOS 独立环境、代理、多窗口、AI 点击和滚动提示、货盘同步及按环境保存销售计划。
- 运营总览按商品展示各账号/环境、价格、最低接受价、累计目标和任务状态；先支持 Vinted 法国站。
- 原照片套组已免费领取、下载、校验并上传。重启保留领取记录和本机文件，没有重复领取。
- TEST 的八项资料、账号绑定及 15 项发布前检查通过。通过应用的受保护按钮真实提交一次，Vinted 显示 `Article en vente`，个人主页出现一件 5 欧元商品，详情页已人工核对。
- **应用内原提交仍是 `uncertain`、`attemptCount=1`，尚未写入在售回执。不要清除记录、重新点击发布或创建重复 TEST 计划。** 网站跳转到了个人主页，当前直接商品导航捕获没有建立结果关联。
- 新增的详情读取器、原刊登核对 UI 和数据库原子投影已保存。它们尚未通过 main/preload 接通；生产界面通过能力检查隐藏关联入口。
- 买家消息、报价、付款订单、运单和真实货盘采购尚未完成联调。用户自行联系测试买家，不要反复索取买家用户名。收到实际事件后再核对商品、账号和对话/订单归属。

## 先恢复代码

需要 Node.js 24。首次使用：

```sh
git clone https://github.com/marcxiang/isola.git
cd isola
npm ci
npm test
npm start
```

已有克隆：先检查本机未提交修改，再执行 `git pull --ff-only`，随后 `npm ci`。本接续点使用标签 `v0.5.3-dev.1`；继续开发优先用 main。

API 密钥、代理密码、Cookie、真实商品/账号编号、照片和运行数据库均未放入公开仓库。新电脑需重新配置密钥并登录账号。源码同步不会带来原电脑的销售状态；没有原始状态时，不要重新刊登已经在售的 TEST。原电脑的运行数据仍在 `~/Library/Application Support/Isola/`。当前没有跨电脑数据库合并或分布式任务锁，两台电脑不要同时执行同一账号的业务。

## 下一步修改位置

1. 先读 `src/commerce-publication-service.cjs`、`src/vinted-publish-submit.cjs` 和 `src/vinted-publication.cjs`。保留原提交的一次性限制；不为了启动后台而移除 `requireReady`。
2. 集成 `src/vinted-listing-receipt.cjs`。读取当前商品页、账号、卖家、本人管理控件、单品价格和主图，两次读取必须一致。含平台费的买家总价不能当作商品售价。
3. 新增主进程 `inspectPublishedListing(planId)` / `associatePublishedListing(planId, reviewToken)`，对应 UI 已在 `src/commerce-ui.cjs`。主进程签发短期令牌，绑定计划、原提交、账号和页面；确认时重新读取，令牌消费后不能重用。渲染进程不能提供 URL、照片路径或“已验证”标志来替代主进程证据。
4. Journal 目前只认可 `observed_submission_navigation`。本次真实完成页是个人主页，必须为明确的操作员确认设计另一种真实来源，不能伪造直接导航证据。照片摘要目前按完整图片 URL 计算，上传缩略图和商品 CDN 变体可能不同；摘要不同须保留待核对，不能复制旧摘要冒充匹配。
5. 在 journal 的持久化回调中接入 `projectPublicationReconciliation`（`src/commerce-publication-reconcile.cjs`）：先投影，再把完整数据库一次落盘。它同步在售 ID、照片使用记录、原周期未提交任务及货盘关联 outbox。当前 outbox 没有发送 worker，只有 pending/needs_review 未发送状态；后续发送必须补齐幂等、未知结果与重启契约。
6. 关联完成后再逐项联调消息、报价、已付款订单和面单。接受报价不等于付款。现存目标 2 件/最低报价 2 欧元是已保存配置，执行真实报价操作前核对业务规则。
7. 采购上限仍为 0。TEST 的 5 欧元是销售价格，不是采购授权；需要真实订单、正确运单、可靠采购总费用和具体单笔/每日上限后才能下单。

## 已确认 TEST 信息

黑色吸尘器配件；无品牌；全新、无原包装和标签；成色 `Neuf sans étiquette`；售价 5 欧元。用户确认包装符合 `Moyen`，没有编造尺寸和重量。分类是 `Maison → Entretien de la maison → Aspirateurs et nettoyage → Accessoires pour appareils de nettoyage`。未确认的自动材质建议已清空，付费 Boost 未选。

实际在售链接保存在当前聊天和私人进度页中；公开仓库不包含账号或真实交易标识。

## 验证记录

- 本接续版：41/41 聚焦 Electron 检查通过，包括新增的 5 项关联 UI 测试；这是隔离临时数据的本地模拟验证，未调用真实关联后端。复查时发现连接状态先于界面请求结束，测试过早点击尚未启用的同步按钮；已改为等待按钮可用后再点击。
- 本接续版完整单元测试：383/383 通过（Node.js 24）。其中投影 12 项、详情读取器 15 项。首次受限环境运行的 5 项本地代理监听被沙箱拒绝；在允许 localhost 的环境重跑全部通过。
- 上一个 0.5.2 提交：356/356 单元测试、36/36 聚焦 Electron 检查通过。较早完整桌面基线 163/163；这些运行有重叠，不能累加。
- 本次真实网页仅验证到 TEST 单次发布和详情人工核对，未验证自动回执关联及后续成交流程。

历次更新见 [CHANGELOG.md](CHANGELOG.md)，模块设计和边界见 [DEVELOPMENT.md](DEVELOPMENT.md)。
