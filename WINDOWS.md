# Windows 使用与构建

版本：0.5.3-dev.2，Windows x64 便携开发版。

## 打开应用

1. 将 ZIP 完整解压到自己的文件夹。
2. 双击 `Isola.exe`。同目录的 DLL、`locales` 和 `resources` 都需要保留，不能只复制 EXE。
3. 在应用内重新设置模型密钥、代理与货盘连接，再登录浏览器账号。

本版本未做代码签名。Windows 数据目录为 `%APPDATA%\Isola\`；应用也会在环境管理页显示实际路径。密钥由 Electron safeStorage 使用 Windows 系统保护保存。照片继承用户数据目录的访问控制，建议使用默认的个人用户目录。

GitHub 源码和此 ZIP 都不含家里 Mac 的 Cookie、运行数据库或照片。不要在没有原始提交记录时新建 TEST 并再次刊登。Mac 与 Windows 的加密密钥不能直接互相解密，当前也没有跨设备数据库合并功能。

## 关联原刊登

必须有原销售计划、账号绑定与 `uncertain / attemptCount=1` 提交记录。在对应浏览器环境打开已发布商品详情，进入运营总览点击“核对原刊登”。检查通过后，确认当前商品属于原提交，再点击“关联已核对刊登”。

核对凭证两分钟有效，只能使用一次；确认时会重新读取账号、卖家、管理控件、标题、单品价格、图片、标签和页面身份，统一保存本地在售回执与照片使用记录。来源记录为操作员核对，不伪造发布跳转。

上传缩略图与商品详情 CDN 图片地址可能不同。目前摘要不一致会阻止关联；请保留待核对记录。关联不会再次发布，不会发送货盘上架请求，不会下采购单。

## 从源码构建

安装 Node.js 24，在 PowerShell 中运行：

```powershell
npm ci
npm test
npm start
npm run package:windows
```

默认输出为 `dist\Isola-win32-x64\`。构建使用 npm 安装并校验过的 Electron Windows 运行时，写入 Isola 图标和版本信息，只复制应用源码及资源，不包含开发依赖、测试或用户数据。输出目录已存在时不会覆盖；重新构建可指定另一个目录：

```powershell
$env:ISOLA_BUILD_OUT = 'C:\path\to\new-build'
npm run package:windows
```

需要 ARM64 时，先安装 ARM64 Electron，再设置 `ISOLA_ARCH=arm64`；当前交付及验证范围为 x64。

## 验证边界

开发环境的 Windows 沙箱需要给 Electron 测试进程临时传 `--no-sandbox` 才能启动；应用源码和交付程序没有默认关闭 Chromium 沙箱。普通 Windows 桌面仍需验证默认启动。模拟测试不能证明 Vinted 实际成交、回执关联或采购已经跑通。
