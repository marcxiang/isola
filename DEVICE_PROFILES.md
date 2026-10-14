# 设备档案与手机兼容模拟

版本：0.5.3-dev.3。设备档案属于一个独立浏览器环境，配置、代理与登录会话分别持久保存。复制配置不复制 Cookie 或网站存储。

## 创建与选择

1. 点击“新建环境”，填写环境名称和启动网址。
2. 在“设备方案”中选择桌面系统或手机型号。Pixel 7、Galaxy S23、iPhone 13、iPhone 14 Pro 方案会同时填入系统、型号、屏幕、DPR、触摸点和 CPU。
3. 根据实际用途设置语言、时区和代理；右侧实时预览会校验设备字段并显示 User-Agent。
4. 保存并启动环境，通过“指纹自检”查看实际读取结果。

“本机原生”保留宿主设备身份；“自定义设备参数”应用可支持的模拟项。切换模式再切回会保留未保存的有效自定义配置。WebRTC 是独立网络策略，两种模式均可选择；默认禁止非代理 UDP。

## 默认机型方案

| 方案 | 系统 | 逻辑屏幕 | DPR | 触摸点 | CPU |
| --- | --- | --- | --- | --- | --- |
| Pixel 7 | Android 14 | 412 × 915 | 2.625 | 5 | 8 |
| Galaxy S23 / SM-S911B | Android 14 | 360 × 780 | 3 | 5 | 8 |
| iPhone 13 | iOS 17 | 390 × 844 | 3 | 5 | 6 |
| iPhone 14 Pro | iOS 17 | 393 × 852 | 3 | 5 | 6 |

预设参考 [Chromium DevTools 设备目录](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/emulation/EmulatedDevices.ts)、[Apple iPhone 13 规格](https://support.apple.com/zh-cn/111872)、[iPhone 14 Pro 规格](https://support.apple.com/en-us/111849)及 [Samsung Galaxy S23 规格](https://www.samsung.com/ph/smartphones/galaxy-s/galaxy-s23-phantom-black-256gb-sm-s911bzkcphl/)。

这些是可编辑的浏览兼容方案，不能证明宿主真的是该型号。Galaxy 的逻辑尺寸由官方物理分辨率按 DPR 3 换算；页面视口还取决于页面 viewport 设置。移动网页未声明适合手机的 viewport 时，出现宽布局可能是正常浏览器行为。

## 实际可模拟的项目

系统与型号、UA、可匹配的 UA-CH、navigator.platform、页面视口、逻辑屏幕、DPR、触摸、CPU 核数、语言、时区及 WebRTC 网络策略。自动 UA 使用当前 Electron 的实际 Chromium 版本。手动 UA 与版本/系统/型号无法对应时，预览会提示并停止附带冲突的 UA-CH 元数据。

手机方案会将普通鼠标点击转换为触摸操作；AI 也使用触摸输入。浏览器可能同时产生正常的兼容鼠标事件，不重复触发点击。

## 检测结果的边界

- 主页面、后续标签和跨域 iframe 的参数已通过本地浏览器验证。
- 独立 Worker 的 navigator.platform 仍可能是宿主平台；SharedWorker 和 Service Worker 的 UA、平台、语言、CPU 和 Client Hints 也可能保留宿主值。内置自检比较页面、独立 Worker 和同源 iframe，未检测的上下文不标为通过。
- GPU、字体、Canvas、音频、媒体能力和实际内核来自宿主。iOS 选项仍运行 Chromium/Blink，不是 iOS WebKit。
- navigator.webdriver、控制对象、GPU、Canvas 和音频显示实际观测值。false、未发现或重复稳定不代表用户是真人，也不保证网站检测通过。
- 自检完全在本地执行，不上传指纹，不调用真实交易网站，不申请摄像头、麦克风或位置权限。

## 运营建议

以账号为核心，固定设备档案与会话，商品计划和任务挂在账号下。日常入口优先展示待处理任务和异常；未知发布结果先核对原记录，避免创建重复计划。设备方案是环境配置，不等于可以同时在两台电脑执行同一账号业务；当前仍无跨设备状态合并或分布式锁。

当前操作租约按浏览器环境管理，同一平台账号绑定多个环境时暂应避免并行执行。后续账号中心应以 `(platform, memberId)` 作为规范账号标识，增加账号级操作租约与未知结果隔离，再聚合设备档案、计划及任务；账号级锁尚未实现，不属于本次设备版本交付。
