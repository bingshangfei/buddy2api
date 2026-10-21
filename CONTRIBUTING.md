# 贡献指南

感谢关注 buddy2api。这是一个**零依赖**的 Node.js（≥18）项目：无需 `npm install`，克隆后即可运行与测试。

## 开发环境

```bash
node src/index.js          # 启动服务（默认 http://127.0.0.1:8000）
npm test                   # 全量测试（node:test，无第三方依赖）
npm run vendor:update      # 从本机 WorkBuddy 安装同步 codebuddy CLI 到 vendor/
```

- 后端 CLI（`vendor/codebuddy-cli`）不入库：需本机装有[腾讯 WorkBuddy 桌面端](https://copilot.tencent.com/)，或在初始化向导中按引导拷贝（Windows 安装版自动完成）。
- 运行时不需要系统 Node：安装版自带 `runtime/node.exe`；开发机用 PATH 上的 node 即可。

## 提交规范

- Commit message 用中文一行式，说明「做了什么」而非「改了哪个文件」，可参考 `git log` 既有风格（`fix:` / `feat:` / `chore:` 前缀 + 中文描述）。
- 提交前请跑 `npm test` 全绿；改了 `src/` 或 `scripts/` 后顺手 `node --check` 一下改动文件。
- Windows 脚本编码铁律：`.ps1`=UTF-8 BOM、`.vbs`=UTF-16LE、`.cmd`=GBK——用普通编辑器另存为 UTF-8 会毁掉 VBS/CMD。

## PR 约定

- 一个 PR 聚焦一件事；行为变更请附测试（`tests/*.test.js`，node:test 风格）。
- 涉及安装/升级/卸载路径的改动，请在 PR 描述里注明你验证过的场景（安装器行为契约见仓库内打包文档）。

## AI 辅助贡献披露

由 AI 编码助手参与完成的贡献，请在 PR 描述中如实注明（哪些部分由 AI 生成、经何种方式验证）。本项目自身即为 AI 深度协作开发，坦诚披露是社区惯例，也是我们对自己的要求。

## 行为边界

本项目定位是**管理自有账号的个人工具**（见 README「使用声明」）。请勿提交以批量注册、账号转售、额度分发为目的的功能或 Issue——这类 PR 不会被合并。
