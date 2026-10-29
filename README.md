# 洛神赋 · Luoshen Fu

洛神赋是一个仅在 macOS 本机运行的 Codex + Deepseek 双智能体任务面板。它拥有独立数据库和运行目录，不读取现有 Taskboard 数据。

## 功能

- 统一看板：待分配、Codex、Deepseek 三条泳道；待执行、执行中、待验证、阻塞、已完成五种状态。
- 任务执行成功后先进入「待验证」，由你确认验收（看板卡片 / 详情页的「验证通过」，或拖到「已完成」列）后才转为「已完成」。
- 独立任务与 `Codex 设计 → Deepseek 实施 → Codex 验证` 三段流程。
- 每个任务独立对话，展示消息、思考摘要、工具执行、审批、用量、错误和原始诊断。
- 全局“回复语言”设置：默认简体中文，可在设置中切换 English 或跟随输入。
- 皮肤：内置 8 套配色 / 壁纸 / 材质 / 圆角组合，可自定义配色、上传本地壁纸并导入导出为 JSON，全部保存在本机。
- 复用本机 Codex 官方登录；Deepseek API Key 保存到 macOS Keychain。
- 本机音乐播放器：手动选择音乐目录后，支持歌单、封面、逐行歌词与逐字跟唱，全程离线，不消耗模型额度。
- 两个智能体通过内置 `luoshenfu` MCP 相互创建子任务并上报进度。
- 贾维斯粒子化身：独立的透明置顶窗口，界面由 WebGL2 自绘，状态随提问、播报与麦克风音量变化；点一下球或喊一声唤醒词即可说话（走 macOS 本机听写），回答流式分段用系统语音念出；它还能查时间与天气、打开网页或文件、截屏并操作这台 Mac，播报全程离线、不消耗模型额度。

## 本地开发

要求：Apple Silicon Mac、macOS 14+、Node.js 22.5+、Rust stable。

```bash
npm ci
npm run check
npm run dev
```

浏览器开发模式使用仓库下 `.data-dev`，不会写正式 App 数据。

## 构建未签名 DMG

```bash
npm run app:build
```

产物位于 `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`。第一次打开未签名 App 时，在 Finder 中右键 App →“打开”→“打开”；也可执行：

```bash
xattr -dr com.apple.quarantine "/Applications/洛神赋.app"
```

签名构建可先设置 `APPLE_SIGNING_IDENTITY` 环境变量，再执行 `npm run app:build:signed`。

## 数据与凭据

- 正式数据：`~/Library/Application Support/com.lochacha.luoshenfu/`
- Codex：使用官方 Codex 的登录和会话目录，不修改 `~/.codex/config.toml`。
- Deepseek：密钥存入登录钥匙串，服务名为 `com.lochacha.luoshenfu.deepseek`；数据库只保存配置状态和末四位。
- 可选 Lo查查工作台同步连接 `https://cl.chuanlie.cc`，需要另行配置个人 API Key；改派成员名单需要在设置中自行填写。不启用该功能即可使用本地任务看板。
- 任务使用 Codex 或 Deepseek 时会向对应服务发送必要的内容；天气查询使用 Open-Meteo。仅应用数据和本地服务保存在本机。

## 版本

当前版本 1.0.2。各版本更新内容见 [CHANGELOG.md](./CHANGELOG.md)。

## 许可

本项目采用 [Apache-2.0](./LICENSE)，第三方声明见 [NOTICE](./NOTICE)。Codex 可执行文件发现与 App Server 通信代码参考了 `dashi-taskboard@2a6970a`，原项目同为 Apache-2.0；Deepseek Harness 按其 MIT 许可随包分发。
