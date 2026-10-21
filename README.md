# buddy2api

[English](README.en.md) | 简体中文

把 **WorkBuddy 的 codebuddy CLI** 封装成 OpenAI 兼容的 API 服务，供支持 OpenAI API 规范的工具配置使用。

buddy2api 自己启动并托管一个 `codebuddy --serve` 进程（CodeBuddy 的 HTTP/ACP 服务模式），本服务充当翻译层：把 OpenAI 格式的 `/v1/chat/completions` 请求转换为 ACP 协议调用，再将流式输出转换为 OpenAI SSE 格式。

**后端进程由 buddy2api 自己托管**——WorkBuddy 桌面端只需安装一次（提供 CLI 二进制），不必保持运行；安装 buddy2api 时向导会把 CLI 拷贝进安装目录并钉死，之后 WorkBuddy 升级/卸载都不影响。

> 本项目与腾讯官方无关，是社区维护的非官方工具。使用前请阅读[使用声明](#使用声明必读)。

## 使用声明（必读）

本项目只有一个初衷：**方便个人管理自己的 WorkBuddy/CodeBuddy 账号**——给自己的本地工具提供一个 OpenAI 兼容入口、顺手自动签到。它是免费、开源、按「原样」提供的个人自用工具。

1. **仅限自用账号**。本项目不支持、不授权任何面向公众的 API 售卖、账号池出租、批量注册小号、卡密分发。批量注册与转售接口配额违反目标平台服务条款，由此产生的一切后果（账号封禁、条款违约、法律风险）由行为人自行承担。
2. **非官方工具，风险自负**。本项目通过逆向 ACP 协议与官方 CLI 交互，上游（腾讯）随时可能调整接口、加强风控导致不可用；因使用非官方客户端导致的账号风控/封禁，由使用者自行承担。
3. **关于 MIT 协议的诚实说明**。MIT 赋予的是代码层面的自由，不赋予以本项目名义宣传、售卖、捆绑分发，或要求作者提供支持与背书的权利。请勿购买任何「收费版」「卡密版」——任何加壳、加密、捆绑收费的分发都是他人篡改的产物，无法审计，且存在窃取你凭据的风险。
4. **作者保留止损的权利**。若滥用行为持续，作者可能随时停止维护、关闭或删除仓库，且不另行通知。

## AI 辅助披露

本项目为 **AI 深度协作开发**：架构设计、业务意图与验收由人类把握，绝大部分代码由 AI 编码代理端到端实现（含逆向分析、链路调度与测试），合并与发布决策由维护者作出。贡献时请遵循 [CONTRIBUTING.md](CONTRIBUTING.md) 的披露要求。

## 阅读导航

- [特性](#特性) / [工作原理](#工作原理)
- [快速开始](#快速开始)（安装包 / 源码运行 / WorkBuddy 前置依赖）
- [控制台与快捷方式](#控制台与快捷方式windows)（Windows）
- [登录](#登录新电脑首次使用) / [账号池](#账号池多账号轮转--故障转移) / [每日签到](#每日签到领积分) / [开机自启](#开机自启可选)
- [后端 CLI 来源与升级](#后端-cli-来源与升级) / [环境变量](#环境变量) / [Token 消耗统计](#token-消耗统计)
- 客户端接入：[OpenAI 思考内容](#openai-思考内容) / [Anthropic Messages 兼容](#anthropic-messages-api-兼容) / [可用模型](#可用模型)

## 特性

- ✅ OpenAI 兼容的 `/v1/chat/completions` 端点（支持 `stream: true/false`）
- ✅ **Anthropic Messages 兼容的 `/v1/messages` 端点**（官方 `@anthropic-ai/sdk` / Claude Code 等客户端可直接接入，含流式 SSE 事件序与工具调用闭环）
- ✅ OpenAI 兼容的 `/v1/models` 端点（模型列表从 codebuddy 会话配置动态获取）
- ✅ 支持模型选择（`auto`、`glm-5.3`、`deepseek-v4-pro`、`kimi-k3-1` 等）
- ✅ 多轮对话（完整历史会作为上下文传递）
- ✅ 思考内容回显：模型的推理过程通过 `reasoning_content` 字段输出（DeepSeek 风格），**可由请求关闭**（见「OpenAI 思考内容」节）
- ✅ 提示词净化：客户端注入的 `ZCode` / `opencode` 等身份字样自动替换为 `workbuddy`
- ✅ 会话隔离：不继承任何已有会话上下文；同一对话的多轮请求默认复用后端会话、只发增量（稳定命中前缀缓存）
- ✅ 连接复用 + 故障自愈：坏连接自动重建并重试一次；首 token / 中途停滞两级假死守卫触发后自动续写（每请求至多 3 次）
- ✅ **自托管后端**：自动启动 `codebuddy --serve`，崩溃后下次请求自动重启
- ✅ Token 消耗统计：`GET /v1/usage` 按模型/按 key 聚合 + 逐请求明细，JSONL 持久化
- ✅ 无需 API Key（本地服务，任意 key 或省略均可）

## 工作原理

```
┌──────────────┐    OpenAI 格式    ┌──────────────────────┐   ACP 协议    ┌────────────────────┐
│ OpenAI 客户端  │ ───────────────> │  buddy2api 代理服务   │ ────────────> │ codebuddy --serve  │
│              │  /v1/chat/completions │  (Node.js, :8000)  │   JSON-RPC    │  后端进程池（1..5）  │
└──────────────┘  <─────────────── └──────────────────────┘  <──────────── └────────────────────┘
                     OpenAI SSE 格式
```

**并发隔离**：后端是一个进程池。每个并发请求分配**独立的后端进程 + 独立会话**，
互不干扰；串行请求复用已释放的后端。池满（默认 5，`BUDDY2API_MAX_BACKENDS`
可调）时新请求排队等待，空闲超过 2 小时的后端自动回收
（`BUDDY2API_IDLE_TIMEOUT_MS` 可调）。

**凭据注入**：启动后端时把登录态里的 accessToken 通过 `CODEBUDDY_AUTH_TOKEN`
显式注入子进程。登录状态因此只依赖一份凭据文件，不受 CLI 自身存储状态影响
（实测出现过 CLI 报 `Authentication required`、但同一 accessToken 仍然有效的情况）。

## 快速开始

### 前置依赖：腾讯 WorkBuddy 桌面端

buddy2api 的后端是 `codebuddy` CLI，它随腾讯 WorkBuddy 桌面端一起安装，**不随本仓库分发**（腾讯专有软件）。开始前请先安装 WorkBuddy 桌面端；CLI 装在非标准路径时，设环境变量 `CODEBUDDY_CLI_PATH` 指向其 `bin/codebuddy` 即可。

不同获取方式的 CLI 来源：

| 获取方式 | CLI 来源 |
|---|---|
| Windows 安装包 | 安装向导从你本机的 WorkBuddy 拷贝一份到安装目录（钉死副本，不随 WorkBuddy 升级变化） |
| 源码运行 | `npm run vendor:update` 从本机 WorkBuddy 同步（或不拷贝，直接回退用系统安装的 CLI） |
| macOS dmg | 构建者在其机器上从 WorkBuddy macOS 版提取并打包（源码构建 dmg 同样需自备 WorkBuddy） |

> ⚠️ 勿对本仓库执行 `git clean -X` / `git clean -fdX`：会物理删除磁盘上的 `vendor/` 副本，在 WorkBuddy 已卸载的机器上不可恢复（需重装 WorkBuddy 或重跑 `vendor:update`）。

### 方式 A：安装包（推荐，新电脑首选）

双击 `buddy2api-setup-<版本>.exe`，一路下一步即可：

- **免管理员权限**：默认装到 `%LOCALAPPDATA%\Programs\buddy2api`（单用户）
- **免装 Node.js**：安装包内置便携版 `runtime\node.exe`，所有脚本自动优先使用
- **需先装 WorkBuddy**：安装完成页勾选「立即配置」启动**初始化向导**，它会自动把本机
  WorkBuddy 里的 codebuddy CLI 拷贝进安装目录（约 94MB，一次性），然后引导登录账号 →
  启动服务 → 可选开启开机自启 / 每日自动签到
- 桌面与开始菜单快捷方式自动创建（橙色立方体图标）
- 卸载时自动停服务、清残留后端进程、移除计划任务与快捷方式；
  `data\`（账号记录）与 `~/.codebuddy`（登录凭据）默认保留

安装包本体由 `installer/build.ps1` 构建（在本机执行，产出单文件 exe）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer/build.ps1
# 产出：installer/dist/buddy2api-setup-<版本>.exe
```

构建工具链已 vendored 在 `installer/toolchain/`（Inno Setup 命令行编译器 +
简体中文语言包），不依赖本机安装 Inno Setup。

### 方式 B：源码运行（开发）

```bash
# 0. 准备后端 CLI：本机装有 WorkBuddy 时，同步一份到项目 vendor/
npm run vendor:update
# （跳过此步也可以——运行时会自动回退到系统安装的 WorkBuddy CLI）

# 1. 无第三方依赖，仅需 Node.js 18+
# 2. 启动代理
npm start
# 或
node src/index.js
```

服务启动后：

```
🚀 buddy2api server running at http://127.0.0.1:8000
   OpenAI-compatible API: http://127.0.0.1:8000/v1
```

首次请求会触发后端启动，日志出现下面两行即就绪：

```
[gateway-pool] Using CLI: .../vendor/codebuddy-cli/bin/codebuddy (vendor copy)
[gateway-pool] Started backend at http://127.0.0.1:xxxxx (PID xxxx)
```

## 控制台与快捷方式（Windows）

创建快捷方式：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1
# 卸载：加 -Remove 参数
```

安装后的布局：

- **桌面**：只放一个 `buddy2api` 图标 —— 打开控制台菜单，所有操作都在里面
- **开始菜单** → `buddy2api` 文件夹：控制台 / 启动服务 / 停止服务 / 账号管理 /
  签到 / 自动签到设置 / 登录 / 查看服务日志（每个都可直接双击执行）

控制台菜单长这样：

```
  ============================================
     buddy2api  控制台
  ============================================

   服务   : 运行中  http://127.0.0.1:8000/v1
   后端   : 2 个进程（并发请求各占一个）
   账号   : 2 个 — 账号A、账号B
   签到   : 今日已执行（最近 2026/9/11 17:27:25）

  --------------------------------------------
    [1] 启动服务            [6] 模型清单 / 接入指南
    [2] 停止服务            [7] 查看服务日志
    [3] 账号管理            [8] 登录 / 检查登录
    [4] 签到（领积分）      [9] 开机启动设置
    [5] 自动签到设置        [C] CLI 检测与升级
    [0] 退出
```

命令行等价入口（脚本与快捷方式共用同一份实现）：

```bash
powershell -File scripts\console.ps1                    # 交互菜单
powershell -File scripts\console.ps1 -Action start      # 直接执行动作
# 动作：start | stop | restart | accounts | checkin | schedule | login | models | log | status | cli
```

日志位置：`%TEMP%\buddy2api.log`

> **脚本编码约定**（改脚本前先看这条）：系统是中文 Windows（码页 936）时，
> `.cmd` 必须存成 **GBK**（UTF-8 会让 cmd 读错位、把半行中文当命令执行），
> `.ps1` 必须存成 **UTF-8 with BOM**，`.vbs` 必须存成 **UTF-16LE**。
> 转换：`python scripts/to-gbk.py <x.cmd>` / `python scripts/to-utf16.py <x.vbs>`（幂等）。
> 控制台入口统一用 `console.ps1`，因为它能把 node 的 UTF-8 输出正确转码显示。

## 登录（新电脑首次使用）

前提：后端 CLI 已就位（安装版向导自动完成；源码运行见 `npm run vendor:update`）。
缺的只是账号凭据：

```bash
npm run login              # 检查登录状态；未登录时打印引导
npm run login -- --open    # 未登录时直接拉起 CLI 登录界面
npm run account            # 只查看账户与余额
```

已登录时会显示账户与余额（启动横幅同样会展示）。未登录时给出三条路径：

1. **CLI 交互登录**：运行 `node vendor/codebuddy-cli/bin/codebuddy`，
   在界面里输入 `/login`，按提示完成浏览器授权
2. **从其他机器复制凭据**：把已登录机器上的
   `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`
   复制到本机同名目录
3. 登录后重启 buddy2api 即可

Windows 快捷方式：「开始菜单 → buddy2api → 登录」，或控制台菜单选 `[8]`。

### 凭据文件定位

CLI 会轮换凭据文件名：规范名 `workbuddy-desktop.info` 之外，还会写出
`workbuddy-desktop.<时间戳>.<pid>.<uuid>.info` 快照。buddy2api 会自动选取
规范名（存在时）或最新的快照，因此不受改名影响。

可用 `CODEBUDDY_AUTH_FILE` 显式指定文件路径。

## 账号池（多账号轮转 + 故障转移）

配置多个账号后，请求会在账号间**轮流分配**；某个账号 429 频控或认证失败时
会**进入冷却**，期间自动使用其他账号。

### 为什么值得配多个账号

| 收益 | 说明 |
|------|------|
| **摊开配额** | 单账号额度有限；多个账号轮流使用可支撑更高请求量（多客户端/多人共用场景明显） |
| **故障转移** | 某账号频控(429)或额度耗尽时自动切换，服务不中断 —— 不用手动换账号 |
| **余额可见** | 启动时会探活并显示每个账号的余额，便于及时发现额度不足 |
| **完全可选** | 只配一个（或不配）账号时，行为与单账号模式完全一致 |

### 添加账号（引导式）

```bash
npm run accounts -- add        # 引导：说明收益 → 拉起 CLI → 登录 → 自动导入
```

Windows 快捷方式：「开始菜单 → buddy2api → 账号管理」，或控制台菜单选 `[3]`。

CLI 里的 `/login` 本身就是**"切换账号"**命令（描述为 *Switch Tencent Cloud
CodeBuddy accounts*），所以添加第二个账号的流程是：

1. 运行 `npm run accounts -- add`（或控制台菜单选 `[3]`）
2. 在弹出的 CLI 界面输入 `/login`，选择另一个账号完成授权
3. 关闭界面 —— 脚本会自动把新账号导入账号池

> CLI 每次登录都会在登录态目录留下带时间戳的快照。add/import 会扫描这些快照，
> 按 uid 去重后收进 `data/accounts/`，所以历史上登录过的账号也能被找回。

### 其他命令

```bash
npm run accounts                              # 列出账号（默认含探活，显示余额）
npm run accounts -- import                    # 从登录态目录导入全部账号
npm run accounts -- import --current          # 只导入当前登录的账号
npm run accounts -- check                     # 只探活
npm run accounts -- remove <uid>              # 移除账号
```

凭据存放于 `data/accounts/<uid>.json`（一账号一文件）。

### 工作原理

- 每个后端进程在启动时注入**某个账号**的 token，因此后端与账号绑定；
  进程池按账号复用/新建
- **会话级账号亲和**：同一**会话**的请求粘住同一账号（命中云端按账号计的
  前缀缓存）。会话标识：请求的 `user` 字段（OpenAI 标准，推荐客户端带上）
  > 首条 user 消息的指纹（OpenAI 协议每轮重发全量历史，首条消息跨轮稳定）
  > 回退 API key。zcode 这类所有会话共用一个 key 的客户端，靠指纹天然区分
  会话；需要精确控制时在请求里传 `user` 字段即可
- 该账号冷却或池满无空闲时自动回退 round-robin，绝不为此排队干等；
  新会话之间按 round-robin 轮换，把配额摊开（亲和命中不推进轮转游标）
- 服务启动时会探活全部账号（走计费接口），失效的直接进冷却 ——
  避免前几个请求白白打到死账号上（`expiresAt` 只是名义有效期，token 可能被提前吊销）
- 冷却时长按失败原因区分：频控 10 分钟 / 认证失败 30 分钟 / 其他错误 1 分钟，
  连续失败时翻倍（上限 4 倍）
- 全部账号都在冷却时，选**最快恢复**的那个继续服务，而不是直接失败

**查看状态**：`GET /v1/accounts` 返回账号列表、可用数量与冷却剩余时间。

## 每日签到领积分

WorkBuddy 每天签到可得积分（默认 100/天，连续签到有额外奖励）。buddy2api 可以
**为账号池里的所有账号自动签到**。

```bash
npm run checkin                    # 立即签到全部账号（已签到自动跳过）
npm run checkin -- --status        # 只查状态，不领取
npm run checkin -- --json          # JSON 输出（供监控消费）

npm run checkin:install-task       # 注册 Windows 计划任务：每天 09:30 自动签到
npm run checkin:remove-task        # 移除计划任务
```

Windows 快捷方式：「开始菜单 → buddy2api → 签到」，或控制台菜单选 `[4]`。

输出示例：

```
每日签到（2026/9/11 17:27:25）

   ✅ 账号A — 领取 100 积分，连续 1 天
   ⏭️  账号B — 今日已签到（连续 10 天）
   合计新增 100 积分
```

**自动签到**用 Windows 计划任务而非服务内置定时器 —— 因为 buddy2api 不一定
24 小时运行，内置定时器会漏签；计划任务独立于服务，且支持"错过时间后开机补跑"。
日志写在 `%TEMP%\buddy2api-checkin.log`。

> 实测：即使某账号的 token 已不能调用模型（余额接口 401），**签到接口往往仍然可用** ——
> 所以失效账号也会被签到，积分照领。

## 开机自启（可选）

默认不开机自启。启用后每次登录 Windows 会**静默**拉起服务：无控制台窗口、
无弹窗，已在运行则自动跳过（幂等）。

```bash
npm run autostart:install-task     # 注册计划任务：登录后自动后台启动服务
npm run autostart:remove-task      # 移除计划任务（不影响正在运行的服务）
```

Windows 快捷方式：「开始菜单 → buddy2api → 开机启动设置」，或控制台菜单选 `[9]`
（可启用/关闭、立即测试、查看启动日志 `%TEMP%\buddy2api-autostart.log`）。

实现要点：计划任务在**登录时**（而非开机瞬间）触发——服务要读用户目录下的账号
凭据，开机瞬间用户配置尚未装载；执行体是 `wscript.exe + scripts/autostart.vbs`
（wscript 本身无控制台，vbs 只写日志、绝不弹窗）。不用「启动」文件夹是因为
里面的项目登录瞬间会闪控制台窗口。

## 后端 CLI 来源与升级

后端按以下优先级选择 `codebuddy` 二进制：

1. `CODEBUDDY_CLI_PATH` 环境变量（显式覆盖）
2. **项目/安装目录内的 vendor 副本** `vendor/codebuddy-cli/`（安装版向导或 `npm run vendor:update` 拷贝）
3. WorkBuddy 安装目录（vendor 副本缺失时回退）
4. `PATH` 搜索

优先 vendor 副本的原因：WorkBuddy 升级可能改变安装路径、卸载或自动更新 CLI，
把后端锁在一个验证过的版本上可以让 buddy2api 不受这些变化影响。

> `vendor/` **不入 git 仓库**（腾讯专有软件）——上面的第 2 级副本由安装向导或
> `vendor:update` 在本机生成。新机器 fresh clone 后要么先跑 `npm run vendor:update`，
> 要么直接依赖第 3 级回退。

```bash
# 从 WorkBuddy 安装目录同步/刷新 vendor 副本（staging 换位：拷贝自检通过才替换，
# 旧副本自动备份为 .bak-<时间戳>，成功后自动清理旧备份仅保留最新一个）
npm run vendor:update

# 只读检测：对比安装目录与 WorkBuddy 的 CLI 版本（退出码 0=最新 1=可升级
# 2=缺失或损坏 3=未检测到 WorkBuddy）
node scripts/vendor-cli.js --check

# 从指定目录同步
node scripts/vendor-cli.js --from "D:\path\to\cli"
```

**Windows 控制台**：选 `[C] CLI 检测与升级`——自动对比版本，安装目录低于 WorkBuddy 时
确认即覆盖升级（含损坏修复与首次安装）；升级前自动停服，完成后可一键重启。

想临时用系统安装的 CLI：`CODEBUDDY_CLI_PATH=/path/to/codebuddy npm start`

> 注意：vendor 副本约 94MB。钉死副本不会跟随 WorkBuddy 自动更新（这是特性，也是责任）——
> WorkBuddy 升级后记得用控制台 `[C]` 或 `vendor:update` 同步一次。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 代理服务监听端口 | `8000` |
| `HOST` | 监听地址 | `127.0.0.1` |
| `CODEBUDDY_CLI_PATH` | 指定 codebuddy 二进制路径 | vendor 副本 → 安装目录 |
| `CODEBUDDY_AUTH_FILE` | 指定登录态文件 | 自动定位（规范名或最新快照） |
| `CODEBUDDY_AUTH_TOKEN` | 直接注入 accessToken（覆盖自动读取） | 从凭据文件自动读取 |
| `GATEWAY_URL` | 直接指定后端 URL，跳过自动启动（调试用） | 自动启动 |
| `POOL_WARM_COUNT` | 启动预创建后端数；默认按登录账号数（每账号 1 个绑定后端，多账号并发不冷启） | 登录账号数（无账号时 `2`）；`0` 禁用 |
| `BUDDY2API_IDLE_TIMEOUT_MS` | 空闲后端回收阈值（毫秒）；调小省内存，调大减少冷启动 | `7200000`（2 小时） |
| `BUDDY2API_DEFAULT_MODEL` | 客户端未指定 model（或写 `auto`/`default`）时使用的模型 | `hy4-preview-f` |
| `BUDDY2API_ANTHROPIC_MODEL` | Anthropic `claude-*` 请求映射到的模型（见下节） | 空 → 用 `BUDDY2API_DEFAULT_MODEL` |
| `BUDDY2API_ANTHROPIC_THINKING` | 请求**未携带** `thinking` 时的回落默认：`1` = 发射 `thinking` 块。正常路径由请求的 `thinking.type` 决定（见「思考内容」节） | `0` |
| `BUDDY2API_OPENAI_REASONING_DEFAULT` | OpenAI 请求**未表态**时的回落默认：`0` = 不回显 `reasoning_content`。正常路径由请求参数决定（见「OpenAI 思考内容」节）。**仅作回落默认，不是 kill switch**——客户端显式 `thinking:{type:'enabled'}` 仍会打开它 | `1` |
| `FIRST_TOKEN_TIMEOUT_MS` | 首 token 守卫阈值；`0` = 禁用 | `120000` |
| `TOKEN_STATS_FILE` | token 消耗统计的 JSONL 持久化路径 | `data/token-usage.jsonl`（设为 `off` 关闭） |

## Token 消耗统计

桥接方案的 token 消耗明细可通过 `GET /v1/usage` 查询，支持按模型 / 客户端 key 聚合与逐请求明细：

```bash
# 总量 + 按模型 + 按 key 聚合
curl http://127.0.0.1:8000/v1/usage

# 带逐请求明细（最近 50 条，可 ?model= / ?key= 过滤）
curl "http://127.0.0.1:8000/v1/usage?detail=1&limit=50"

# 清空统计（内存与持久化文件一并重置）
curl -X DELETE http://127.0.0.1:8000/v1/usage
```

响应示例：

```json
{
  "object": "token_usage",
  "total": { "requests": 4, "prompt_tokens": 6, "completion_tokens": 1, "total_tokens": 7 },
  "models": [{ "model": "fast-model", "requests": 4, "prompt_tokens": 6, "completion_tokens": 1, "total_tokens": 7, "last_used_at": "..." }],
  "keys":   [{ "key": "smoke-test", "requests": 4, "prompt_tokens": 6, "completion_tokens": 1, "total_tokens": 7, "last_used_at": "..." }],
  "records": [{
    "ts": "2026-09-05T01:56:53.149Z", "model": "fast-model", "requestedModel": "auto",
    "prompt_tokens": 6, "completion_tokens": 1, "total_tokens": 7,
    "usage_source": "estimated", "key": "smoke-test",
    "status": "completed", "stream": false, "tool_calls": 0, "duration_ms": 9321
  }]
}
```

统计口径说明：

- **模型归因**：优先取 `usage_update` 事件报告的实际模型；客户端指定了 `model` 则用指定值；`auto` 时用会话默认模型（session/new 的 currentValue）。
- **token 数量**（`usage_source` 字段区分）：
  - `reported` —— WorkBuddy 网关在 `usage_update` 事件中上报的精确值（部分版本支持）；
  - `estimated` —— 当前网关版本大多不回传 usage，此时按文本估算（CJK ≈1 token/字、其余 ≈1 token/4 字符），保证明细不为 0。图片 token 不参与估算（按文本无法估，相关请求统计偏低）。
- **持久化**：每条明细追加写入 `data/token-usage.jsonl`，服务重启后自动回放恢复最近 5000 条（聚合由明细实时计算）。
- **不重复计费**：一次请求（含多轮工具调用续跑）只记一笔，在终态（完成/超时/中断/出错）落账；429 频控等未产生模型输出的请求不计。
- 流式响应支持 OpenAI 标准的 `stream_options: {"include_usage": true}`，会在末尾追加带 `usage` 的 chunk（值为网关上报口径，未上报时为 0）。

## 在 workbuddy 中配置

在 workbuddy 的模型配置中添加一个 OpenAI 兼容的 provider：

```json
{
  "providers": {
    "workbuddy": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "apiKey": "local",
      "models": ["auto", "glm-5.3", "deepseek-v4.1-flash", "deepseek-v4-pro", "kimi-k3-1", "minimax-m3", "hy3"]
    }
  }
}
```

然后在对话中使用 `workbuddy/auto` 作为模型即可。

## 在 workbuddy（兼容模式）中配置

编辑 `~/.config/workbuddy/workbuddy.json`（或项目 `.workbuddy.json`）：

```json
{
  "provider": {
    "workbuddy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "WorkBuddy",
      "options": {
        "baseURL": "http://127.0.0.1:8000/v1",
        "apiKey": "local"
      },
      "models": {
        "auto": { "name": "Auto" },
        "glm-5.3": { "name": "GLM-5.3" },
        "deepseek-v4-pro": { "name": "DeepSeek-V4 Pro" },
        "deepseek-v4.1-flash": { "name": "DeepSeek-V4.1 Flash" },
        "kimi-k3-1": { "name": "Kimi-K3" },
        "minimax-m3": { "name": "MiniMax-M3" }
      }
    }
  }
}
```

然后运行 workbuddy，按 `/models` 选择 WorkBuddy 模型。

## 直接测试

```bash
# 列出模型
curl http://127.0.0.1:8000/v1/models

# 非流式对话
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "你好"}]}'

# 流式对话（思考内容通过 reasoning_content 字段回显）
curl -N http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "数到 5"}], "stream": true}'
```

不同 API Key（Authorization Bearer）会隔离不同的会话池，互不干扰。

## OpenAI 思考内容

`/v1/chat/completions` 的思考可见性由**请求**决定——与 Anthropic 侧的契约同构
（单一决策点 + 只控制转发），但**默认方向相反**：OpenAI 侧的既有行为是「始终回显」，
所以不表态时默认**开**，以避免对既有客户端静默破坏。

| 请求里的字段 | 行为 |
|---|---|
| `reasoning_effort: "none"`（大小写/空白不敏感） | 不发射 `reasoning_content` |
| `thinking: {type:'disabled'}` | 不发射 |
| `thinking: {type:'enabled'}` / `{type:'adaptive'}` | 发射（**压过**环境变量） |
| `thinking: {type:'enabled', display:'omitted'}` | **不**发射（要求只留签名不回正文，本代理产不出真签名） |
| `reasoning_effort: "low"` / `"high"` / 其他任意值 | **不表态** → 回落环境变量（其规范语义是「思考量」而不是「可见性同意」） |
| 未携带 / 未知值 / 非对象 | 回落 `BUDDY2API_OPENAI_REASONING_DEFAULT`（默认回显） |

两条规则值得单独说明：

- **仲裁 fail-closed**：同时出现显式关与显式开时，**关压过开**。反例
  `{"reasoning_effort":"none","thinking":{"type":"enabled"}}`——本 wire 的原生旋钮
  （`reasoning_effort`）表达的「别发」不应被外来字段静默压过。
- **已知取舍**：归一化（去空白 + 转小写）**只作用于 `reasoning_effort`**；`thinking.type` /
  `thinking.display` 是枚举值，按字面比较、**大小写敏感**——非枚举取值一律回落（与 Anthropic 侧
  同口径）。另有：不做同义词映射，因此 `"off"` / `"disable"` 会落到「不表态」→ 回落成**回显**
  （fail-open）。这是刻意的：替客户端猜同义词比诚实回落更容易出错。

思考关闭时，阶段进度文案（如「正在压缩上下文…」）改以 SSE 注释行
（`: progress …`）转发——保活且保留「服务没卡死」的可观测性，同时不占用
`reasoning_content` 通道。

> ⚠ 本代理**只控制转发**，**不会减少上游的思考生成与计费**。真正降低思考成本
> 需要换模型或换后端；关掉这里的回显只是让客户端不再收到这部分载荷。

## Anthropic Messages API 兼容

除 OpenAI 格式外，代理同时提供 Anthropic Messages 端点，官方 `@anthropic-ai/sdk`、Claude Code 等
客户端可直接把 `baseURL` 指过来使用。**`baseURL` 填 `http://127.0.0.1:8000`，不要带 `/v1`**——SDK 会在
baseURL 后自动拼接 `/v1/messages`（服务端按绝对路径匹配），带了 `/v1` 会请求到 `/v1/v1/messages` 而 404。
Claude Code 设 `ANTHROPIC_BASE_URL=http://127.0.0.1:8000`（同样不带 `/v1`）；
`x-api-key` / `ANTHROPIC_AUTH_TOKEN` 任意值即可，仅用于会话隔离，不校验：

| 端点 | 说明 |
|------|------|
| `POST /v1/messages` | Anthropic Messages（支持 `stream: true/false`） |
| `POST /v1/messages/count_tokens` | 上下文 token 估算 |

```bash
# 非流式
curl http://127.0.0.1:8000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,
       "messages":[{"role":"user","content":"你好"}]}'

# 流式（Anthropic 命名事件：message_start → content_block_* → message_delta → message_stop）
curl -N http://127.0.0.1:8000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,"stream":true,
       "messages":[{"role":"user","content":"数到 5"}]}'
```

### 模型名

**后端没有 Claude 模型**。`claude-*`（及 `anthropic.*`）请求会被映射到代理默认模型，但**响应里回显
你请求的原始名字**——所以客户端以为自己连的是 Claude，实际跑在默认模型上。映射发生时服务端会打一条
告警日志，写明实际使用的模型名。

想换映射目标就设 `BUDDY2API_ANTHROPIC_MODEL=<模型 id>`（例如 `glm-5.3-flash`）。
非 `claude` 前缀的 id 会原样透传给后端（隐藏 id 仍可用）。

### 鉴权与会话隔离

`x-api-key` 与 `Authorization: Bearer` 都被读取，用于**会话隔离**（不同 key 走不同的会话池、
挂起工具调用互不干扰）。**服务不校验 key 的值**——本地服务，任意字符串或省略都行。

优先级：`Authorization: Bearer` > `x-api-key` > `?apiKey=` > 缺省共用 `default`。

> ⚠️ 不传 key（或所有客户端用同一个 key）会共用同一个会话池，可能互相顶掉挂起的工具调用。

### 支持范围与已知行为

**支持**：文本 / 图片（`base64` 与 `url` 两种 source）/ 工具调用闭环（`tool_use` ↔ `tool_result`）/
`system`（字符串或块数组）/ 思考内容（由请求的 `thinking.type` 决定，见下节）。

**接受但忽略语义**（不会报错，也不会生效）：

| 参数 | 说明 |
|------|------|
| `max_tokens` | **没有硬上限**。它是 Anthropic 的必填字段，报错会让所有请求失败，所以只接受不执行——别指望它截断输出 |
| `temperature` / `top_p` / `top_k` | 后端不暴露这些采样参数 |
| `stop_sequences` | 同上 |
| `tool_choice` | 工具是否被调用由后端决定 |
| `metadata` | 忽略 |

**不支持的输入**（会被静默忽略，不报错）：

- **服务端工具**：`web_search_20250305` / `computer_use_20250124` / `bash_20250124` /
  `text_editor_20250124` 等带 `type` 的内置工具。这类工具的语义是"由 Anthropic 后端执行"，
  本代理没有对应执行器，所以会被忽略（请求退化成不带工具的纯对话，避免把客户端没声明过的
  工具调用丢给它）。
- `document` 块、citations、`redacted_thinking` 块
- prompt caching（`cache_control`）、`anthropic-beta` 请求头
- `/v1/messages/batches`、`/v1/files` 端点

**思考内容**：可见性由**请求**决定，符合 Anthropic「按请求 opt-in」的契约（不是一个进程级开关
——同一个代理要服务多个客户端，「A 客户端要、B 客户端不要」必须能同时表达）：

| 请求里的 `thinking` | 行为 |
|---|---|
| `{type:'enabled'}` / `{type:'adaptive'}` | 发射 `thinking` 块与 `thinking_delta` |
| `{type:'enabled', display:'omitted'}` | **不**发射（客户端要求只留签名、不回正文；本代理产不出真签名，只能按不可见处理） |
| `{type:'disabled'}` | 不发射（**压过**环境变量） |
| 未携带 / 未知 `type` / 非对象 | 回落 `BUDDY2API_ANTHROPIC_THINKING`（默认不发） |

`thinking` 块的 `signature` 字段**恒为空串**：构造不出真实签名，而 SDK 的
`ThinkingBlock.signature` 是必填、无默认值——**省略**会让严格校验模式
（`_strict_response_validation`）的客户端抛 `APIResponseValidationError`。空串是唯一合法降级，
与 DashScope 官方做法一致（其文档明确「`content.signature` 当前固定为空字符串」）。
`budget_tokens` 接受但忽略语义（后端不支持按 token 预算分配）。

流式响应**不含** OpenAI 的 `data: [DONE]` 哨兵；流内错误以 Anthropic 形状的
`event: error`（`{"type":"error","error":{"type":"api_error","message":"…"}}`）终止。

## 可用模型

客户端把 `model` 字段设成任意模型 ID 即可，代理**原样透传**给网关，不做映射或替换。

**计费系数**由网关在模型列表里标注（`x0.00` 即免费），可直接查询当前账号的实时清单：

```bash
node scripts/models.js          # 完整表格 + 各 agent 接入配置
node scripts/models.js --guide  # 仅接入配置（服务没启动也能看）
node scripts/models.js --brief  # 一行摘要
```

或在**控制台 [6] / 开始菜单「模型清单 / 计费」**查看。

**接入其他 agent / 客户端**：任何支持 OpenAI 兼容接口的工具都用同一套三件套配置——Base URL（`http://127.0.0.1:8000/v1`）、API Key（任意值，必填时填 `local`）、模型 ID（上表任选）。Cherry Studio / ChatBox、Cline / Roo Code、aider、Open WebUI / Dify 的具体填法见 `node scripts/models.js --guide` 输出。下表为示例（以运行时查询为准）：

| 模型 ID | 计费系数 |
|---------|----------|
| `hy4-preview-f` | **免费**（x0.00） |
| `hy3` | **免费**（x0.00） |
| `deepseek-v4.1-flash` | x0.03 |
| `hy3-x` | x0.05 |
| `glm-5.3-flash` | x0.06 |
| `minimax-m3` | x0.25 |
| `deepseek-v4-pro` | x0.51 |
| `kimi-k2.6` | x0.52 |
| `kimi-k2.7` | x0.57 |
| `glm-5v-turbo` | x0.71 |
| `glm-5.3` / `glm-5.2` / `glm-5.1` | x0.79 |
| `kimi-k3-1` | x1.62 |
| `auto` | 未标注（按实际路由到的模型计费） |
| `custom-local:deepseek-v4-flash` / `custom-local:qwen3.7-plus` | 未标注 |

> ⚠️ **`hy4-preview`（不带 `-f`）不在列表里**。它是旧版遗留的隐藏 ID，`setModel` 仍会接受，
> 但**按收费模型计费**——看起来在用免费的混元，实际在扣积分。免费的是 `hy4-preview-f`。
> 同理，「未标注」不等于免费：默认的 `auto` 就属于未标注但仍计费。
>
> 代理在遇到不在列表里的模型 ID 时会在日志中显式告警，不再静默回退到 `auto`。

### 默认模型（默认免费）

客户端**不指定 `model`**，或写 `auto` / `default` 时，代理使用 **`hy4-preview-f`**（免费）。

原因：网关的 `auto` 会路由到收费模型——实测一条 3.2k prompt 的极短请求就扣 0.52 积分。
而多数客户端习惯不带 `model` 或写 `auto`，放任不管等于默认烧积分。
显式指定具体模型 ID 的请求不受影响，仍然原样透传。

```bash
# 换回网关的自动路由（会按实际路由到的模型计费）
BUDDY2API_DEFAULT_MODEL=auto npm start

# 或指定任意模型作为默认
BUDDY2API_DEFAULT_MODEL=glm-5.3-flash npm start
```

当前生效的默认模型会打印在启动横幅里，也可以通过 `GET /` 的 `default_model` 字段查询。

## 注意事项

- **不需要 WorkBuddy 桌面应用运行**，buddy2api 自己托管后端 CLI 进程
- 只需要：一份 codebuddy CLI（安装目录/项目内 `vendor/`，或本机装过 WorkBuddy）＋ 一份有效账号凭据
- 多轮上下文通过消息历史传递；同一对话默认复用后端会话、只发增量
- 并发请求各占一个独立后端进程，互不串台；池上限默认 5，超出排队等待
- Agent 会附带系统提示和工具定义，因此 `prompt_tokens` 有约 22k 的基线开销（非泄漏上下文）
- 提示词净化会把 `ZCode` / `zcode` / `opencode` / `OpenCode` / `Claude Code` 替换为 `workbuddy`，避免后端收到其他客户端注入的身份描述
- 端口 `8000` 只监听本机，如需局域网访问请设置 `HOST=0.0.0.0` 并注意安全
- 后端 CLI 以 `--auth none` 启动（无认证），仅监听 `127.0.0.1`；请勿把该端口暴露到网络
- 凭据中的 accessToken 有有效期（通常数月）。过期后重新登录一次即可；`npm run login` 会提示
