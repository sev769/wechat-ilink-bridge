# WeChat-iLink Bridge（整合版）

License: [MIT](LICENSE) ｜ 版本：0.2.2 ｜ 需要 Node.js >= 18

> **English summary:** A personal-use build of the WeChat iLink bridge (CLI + MCP) made for Muse, integrating the upstream project, a community fork's five patches, and nine further improvements adapted from peer projects — all verified live on the maintainer's own account. Provided as-is: no updates, fixes, or support are promised.

WeChat-iLink Bridge（`wxb`）是一个面向 AI Agent 的微信 iLink 本地桥接工具：让 Agent 通过微信 ClawBot 通道收发消息。它提供两个入口：

- **`wxb`**：命令行工具，扫码登录、长轮询收消息、发文本/图片/文件/语音
- **`wxb-mcp`**：stdio MCP 服务，把收发能力暴露给支持 MCP 的 Agent 客户端

账号凭证、消息历史、附件全部只保存在本机状态目录；命令输出（stdout）不包含 bot token、context token、CDN 签名 URL 和上传密钥，这些只在桥内部流转。

> **关于本版本**：本整合版是维护者**个人自用**的版本——为在 Muse 上自用而拼装、实测，发布出来仅供参考与存档。它按现状（as-is）提供：**不承诺后续更新、不保证问题修复、不提供技术支持**（许可层面的无担保声明见 LICENSE 的 MIT 条款）；功能取舍也按维护者自己的使用场景决定。需要持续维护的版本，请优先考虑上游原版（见文末“致谢与许可”）。

## 已知限制（在 Muse 上实测）

以下限制是本项目（以 Muse 为宿主）在 **Muse** 上实测到的，先列在开头免得踩坑（细节见各对应章节）。它们就是这个项目当前的已知限制；其中出站语音一条另有多个独立项目的复现记录，证据最强。带“实测”的结论截至 **2026 年 11 月**，iLink 的行为日后可能变化，届时以新的实测为准：

- **机器人发不出原生语音条**（2026-11 实测）：`send --voice` 接口返回成功，但语音不会出现在微信里，被服务端静默丢弃（详见“发送语音”一节，含官方仓库出处）。想让对话用户听到声音，请用 `--file` 发送音频文件；接收语音不受影响。
- **单个 context token 最多发送 10 条消息**（2026-11 实测）：第 11 条起返回 `INVALID_CONTEXT_TOKEN`。超限不丢消息，桥会排队，等对话用户下次发来消息、令牌刷新后自动补发（详见“context token 的行为（实测）”）。
- **不能主动发起对话**：发送依赖对话用户先发来的消息所携带的 context token；该用户从未给机器人发过消息时没有令牌可用，发不了。
- **长轮询节奏有下限**：单次 `fetch` 在无新消息时被服务端保持约 19.2 秒（2026-11 实测），轮询周期快不过这个数（见“快速开始”的小贴士）。
- **轮询偶尔晚一轮交付**（2026-11 实测）：消息到达时通常在 1 秒内被正在等待的长轮询接住，但在一轮 10 条真实消息的样本里有 4 条等了 14–33 秒（约一个轮询周期）才被接住，成因尚未定性。自动回复的端到端时延构成见 extras 一节。
- **同一账号只宜跑一个轮询器**：fetch 长轮询不持账号锁的设计，前提是同一账号只有一个轮询器在跑。
- **扫码登录可能被风控拦截**（本项目 2026-11 实测遇到）：云服务器、机房网络等环境下扫码时，可能提示「此OpenClaw的运行环境存在风险，暂无法连接」（见“扫码登录的风控提示”）。
- **Muse 运行时换机后全局命令会消失**（2026-11 实测）：宿主机器被平台替换时系统目录重置，全局安装的 `wxb`、`silk-encoder` 需重装；账号与登录态保存在家目录，不受影响、无需重新扫码。extras 的轮询脚本已内置自动重装自愈（见“Muse 运行时重启 / 换机的影响与应对”）。
- **context token 约 24 小时失效**是社区说法，本项目未实测，列在此处仅作提醒（见“context token 的行为（实测）”）。

## 本整合版的构成

本项目不是从零写的，而是三个来源的合并（逐项出处见 [CHANGELOG.md](CHANGELOG.md)）：

| 构成 | 来源 |
|---|---|
| 桥本体（CLI、MCP、状态管理、媒体收发） | [DONGH4O/wechat-ilink-bridge](https://github.com/DONGH4O/wechat-ilink-bridge) 原版 |
| 5 个补丁：发语音、fetch 长轮询不持锁、残留账号锁回收 | [lyrnoxfan/wechat-ilink-bridge](https://github.com/lyrnoxfan/wechat-ilink-bridge)（原版的 Fork） |
| 2 个修复：SILK 编码器路径改为配置/PATH 查找（原 Fork 写死为作者本机路径）；透出入站语音的微信自带转写（见下） | 本整合版 |
| 9 个借鉴补丁（逐项见下）：语音默认发文件、额度计账与打包、引用还原、发送前复查合并、队列可见可控、退避表、token 年龄标注、去重与单轮询器租约、健康自检 | 本整合版（源自对 30 余个同类 iLink/ClawBot 项目的调研） |

9 个借鉴补丁逐项说明（每条末尾的“来源”是该做法的出处——思路、规格或实测参数借鉴自所列项目，均出自本项目对 30 余个同类 iLink / ClawBot 项目的调研；实现代码为本项目自行编写）：

1. **出站语音默认以文件投递**：`send --voice` 默认按文件附件发出（可达），原生 SILK 语音条只在显式 `--native-voice` 时才发（见“发送语音”的平台限制）。来源：[panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin)（出站语音默认关、被拒自动降级为文件）、[gfydfhcf/wechat-ilink-muse-bridge](https://github.com/gfydfhcf/wechat-ilink-muse-bridge)（音频以文件 / 视频发出）、[zongrongjin/weixin-ilink](https://github.com/zongrongjin/weixin-ilink) 三家收敛出的同一方案；腾讯官方插件同样从不发原生语音、一律走文件。
2. **发送额度计账与长文打包**：按 context token 记录已用条数，发送结果带 `quota`；长文本先按剩余额度重打包，装不下整条排队并注明原因（见“context token 的行为（实测）”）。来源：[Thysrael/Horizon](https://github.com/Thysrael/Horizon) 的配额计数器与预算感知发送（按令牌计数到 10、预算不足时打包合并、余额不多时加续期页脚）；记账口径另参考 [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) 的分片间隔与 [chen-zhanjie/hyperf-wechat-clawbot](https://packagist.org/packages/chen-zhanjie/hyperf-wechat-clawbot) 的“流式气泡也计 1 条配额”。
3. **引用消息还原**：入站消息带引用编号时，在本地引用缓存中认领原文并附在消息上。实测注意：发送回执返回的 `message_id` 与引用所指的编号**并不相同**（两者数值接近、差值无固定规律），认领因此分三档——精确命中、同编号段 + 时间最近、数值接近 + 时间最近（分不清时宁可不认领）；已在真实账号上连续实景验证命中。来源：缓存规格来自腾讯官方 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 的 quoteCache（按服务端编号查找、保留 30 天 / 1 万条）；出站回执中服务端编号的字段依据 [gfydfhcf/wechat-ilink-muse-bridge](https://github.com/gfydfhcf/wechat-ilink-muse-bridge) 的实验记录提取；“回执编号 ≠ 引用编号”与三档认领是本项目实测后自行设计的适配，不是来源项目的现成方案。
4. **发送前复查合并**：自动回复的 worker 在回复前复查一次新消息，把同一用户的连发合并为一轮回复（落在 worker 指令层实现，约定见 `docs/auto-reply-worker.md`，避免第二个轮询器与主轮询冲突）。来源：[gfydfhcf/wechat-ilink-muse-bridge](https://github.com/gfydfhcf/wechat-ilink-muse-bridge)（其自述为该生态少见的发送前复查合并做法）；本项目把它落在 worker 指令层而非桥内，是为遵守单轮询器约束所做的适配。
5. **失败队列可见可控**：队列条目带状态（待发/重试中/被会话过期阻塞）、年龄与稳定 `client_id`；新增 `queue retry` / `queue discard`；会话过期导致的条目会被标阻塞、跳过自动补发，待新令牌到达自动解阻。来源：[panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin) 的 `/outbox`（落盘待发队列可查、可手动重试）、[anyhui/agent2wechat](https://github.com/anyhui/agent2wechat) 的 sent / failed 分级与“会话过期不重试”、[peiyuanqi/scv](https://github.com/peiyuanqi/scv) 的同 `client_id` 幂等重试；并吸收 [gfydfhcf/wechat-ilink-muse-bridge](https://github.com/gfydfhcf/wechat-ilink-muse-bridge) 的反面教训（无幂等保证的自动重试会双发），故本项目只做可见可控、不做无脑自动重试。
6. **长轮询退避表**：请求超时视为正常轮询结束、立即再轮；一般可重试失败退避 2 秒，连续失败三次起 30 秒；服务端下发的 `longpolling_timeout_ms` 会被采用。来源：退避表采用 [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) 与 [SpenserCai/weixin-agent-sdk-rs](https://github.com/SpenserCai/weixin-agent-sdk-rs) 两家收敛的同一组实测参数；动态采用服务端 `longpolling_timeout_ms` 来自 [epiral/weixin-bot](https://github.com/epiral/weixin-bot)。
7. **token 持久化与年龄标注**：context token 落盘时记录更新时间；`INVALID_CONTEXT_TOKEN` / `NO_CONTEXT_TOKEN` 报错带令牌来源与年龄（秒），便于判断是额度耗尽还是令牌过期。来源：令牌落盘来自 [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) 与 [chenhg5/cc-connect](https://github.com/chenhg5/cc-connect)；发送时的三级回退来自 [phpgao/ilinkgo](https://github.com/phpgao/ilinkgo)；把令牌年龄写进报错文案来自 [turmind/halo-agent](https://github.com/turmind/halo-agent)。
8. **入站去重与单轮询器租约**：已处理消息 id 持久去重（保留最近 500 条）；fetch 运行时持有租约文件，同一账号的第二个 fetch 立即报 `POLLER_ALREADY_RUNNING`，持有者进程已死或租约过期可接管。来源：[gfydfhcf/wechat-ilink-muse-bridge](https://github.com/gfydfhcf/wechat-ilink-muse-bridge)（500 条 message_id 落盘去重、多驱动共享单实例锁）；[nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) 的 5 分钟滑动窗口去重是弱化版，本项目未采用。
9. **健康自检**：新增 `wxb doctor`，检查 ffmpeg / ffprobe / SILK 编码器、账号与登录态、context token 存在与年龄、队列深度与阻塞数、状态文件可读性；退出码 0 健康 / 1 降级 / 2 损坏。来源：退出码 0 / 1 / 2 的 health 设计与“故障只提醒一次、恢复报平安”的告警节制来自 [gfydfhcf/wechat-ilink-muse-bridge](https://github.com/gfydfhcf/wechat-ilink-muse-bridge)；`doctor` 命令形式参考 [panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin) 的 doctor（其带 `--fix` 自动修复，本项目只做检查、不自动改动系统）。

许可证为 MIT，原作者与补丁作者的版权声明均完整保留。

## 运行环境

- 本整合版是**为 Muse 而做的**：它以 Muse 作为宿主 Agent，开发与全部实测都在 Muse 上完成（Linux 云端容器，桥以 CLI / MCP 形式被 Muse 调用）。原版没有指定宿主，本整合版明确指定 Muse；配套的 24 小时自动回复示例（extras）也是按 Muse 的 hook 运行时写的。
- 因此本文档记录的功能与限制，都是 Muse 上的实测结论：例如本机缺少现成的语音合成 / 识别工具、云端网络出口触发微信登录风控（见下文），都是这个运行环境的具体条件。本项目不承诺在其他 Agent 宿主上的表现。
- Muse 的运行时机器可能随平台部署被整体替换：只有家目录（`~`）持久保留，系统目录会被重置。本项目的部署方式已按这一特点设计（耐久副本与重装脚本放在家目录、轮询脚本可自愈重装），详见下文“Muse 运行时重启 / 换机的影响与应对（实测）”。

## 功能一览

**收消息**
- `fetch` 长轮询拉取入站消息，先落本地历史再输出给 Agent
- 入站语音如带微信自带转写（`voice_item.text`），会透出为该消息的文本，Agent 不需要语音识别即可读到内容（原版与 Fork 的解析都会丢弃这个字段，本整合版已修复）
- `--download-media` 下载图片、文件、语音、视频到本地 `inbox`（AES-128-ECB 解密、按文件头推断 MIME、文件名安全清理），输出只给本地路径和元数据
- 下载失败不影响同条消息的文本输出，也不阻断游标推进
- 引用消息尽力还原：入站消息带引用编号时，桥在本地引用缓存中认领被引用原文（保留 30 天 / 最多 10000 条，正文截断 500 字），命中后以 `quotedMessage` 附在消息上交给 Agent

**发消息**
- 文本（自动分片）、文件、图片，均支持发送前显示“正在输入”（`--typing`）
- **语音（有限制）**：`send --voice` 可把音频转码为 SILK 并发送，但原生语音条目前会被 iLink 服务端静默丢弃（见“发送语音”一节）；想让与机器人对话的微信用户（下称对话用户）听到声音，请用 `--file` 发送音频文件
- 发送依赖对话用户的 context token（详见“Agent 收发循环”里的“context token 的行为（实测）”）：对话用户先给机器人发一条消息即可刷新；token 失效导致的发送失败会进入延迟队列，该用户下次发消息时自动补发第一条，不刷屏
- 发送结果带额度信息（`quota` 的 limit / used / remaining）；单条长文本会先按剩余额度打包合并为最少分片，仍装不下则整条排队并注明原因

**稳定性**
- fetch 长轮询期间不持有账号锁，并发 `send` 不再报 `STATE_LOCK_TIMEOUT`（部署前提：同一账号只跑一个轮询器）
- 进程被杀死后残留的账号锁文件按 PID 存活状态自动回收，不再永久超时
- 单轮询器租约：同一账号已有 fetch 在跑时，第二个 fetch 立即报 `POLLER_ALREADY_RUNNING`；长轮询失败按退避表重试（请求超时视为正常结束、立即再轮；一般失败 2 秒；连续三次起 30 秒）

**接口与运维**
- MCP 工具：`fetchMessages`、`sendText`、`sendFile`、`listUsers`、`status`、`analyzeMedia`
- `poll` 前台循环、`heartbeat` 单次保活（适合计划任务）、`alias` 用户别名、`queue` 延迟队列查看/重试/丢弃、`cleanup` 按保留策略清理历史与附件
- `wxb doctor` 一键健康自检（编码器与 ffmpeg、账号与登录态、context token 年龄、队列深度与阻塞数、状态文件可读性），退出码 0 健康 / 1 降级 / 2 损坏
- `analyzeMedia` 提供本地媒体的 MIME/大小/sha256/图片尺寸/文本预览；图片问答、语音转写等模型能力由宿主 Agent 凭附件路径自行完成（桥本身不调用任何大模型 API），说明见 `docs/m15-multimodal-helper.md`

## 快速开始

### 一键安装（Linux/macOS）

```bash
./install.sh
```

脚本会依次：安装本包为全局命令（`wxb`、`wxb-mcp`）→ 从 `third_party/silk-v3-decoder` 编译并安装 SILK 编码器 `silk-encoder` → 运行测试 → 自检两个命令可用。发语音还需要系统装有 `ffmpeg`、`ffprobe`，脚本会检查并提示。

### 手动安装

```bash
npm test            # 可选：先跑一遍测试
npm install -g .    # 安装 wxb / wxb-mcp
wxb help
```

Windows 下把 `npm` 换成 `npm.cmd` 即可；PowerShell 执行策略拦截 `npm.ps1` 时用 `npm.cmd`，无需改系统策略。

### 登录与收发

```bash
wxb login --json                                   # 扫码登录，凭证写入本地状态目录
wxb accounts --json                                # 查看已保存账号（不输出 token）
wxb fetch --timeout 40000 --download-media --json  # 收一批消息（含附件下载）
wxb send --user <fromUserId> --text "收到" --json
wxb send --user <fromUserId> --image /path/to/pic.jpg --typing --json
wxb send --user <fromUserId> --file /path/to/report.pdf --json
wxb send --user <fromUserId> --voice /path/to/msg.mp3 --json
```

小贴士：`fetch` 一次长轮询在无新消息时会被服务端保持约 19.2 秒才返回（2026-11 实测，连测 6 次为 18.96–19.20 秒）。这不是两次轮询之间必须等待的间隔——返回后立即发起下一次轮询没有额外限制；它就是单个轮询周期的天然下限，所以轮询间隔设为约 20 秒已是贴地，再调低没有收益；有新消息时服务端会立即返回，不必等满。`fetch` 建议带 `--timeout 40000`：默认的短超时比 19.2 秒还短，会把正常的空轮询误报为 `NETWORK_ERROR`。

## 命令速查

| 命令 | 作用 |
|---|---|
| `login` | 扫码登录并保存账号 |
| `accounts` | 列出已保存账号（不含 token） |
| `status` | 查看账号、游标、会话数、历史数 |
| `fetch` | 长轮询收一批消息，可选下载附件 |
| `send` | 发文本 / 文件 / 图片 / 语音（`--text`/`--file`/`--image`/`--voice`，`--stdin` 可从管道读文本） |
| `poll` | 前台重复 fetch，轻量保活 |
| `heartbeat` | 单次保活 fetch，适合计划任务；无消息且客户端先超时返回 `idle_timeout` 属正常 |
| `alias` | 给 `fromUserId` 维护可读别名（set/get/list/resolve/remove） |
| `queue` | 查看延迟补发队列（带状态与年龄），或 `queue retry <id>` 重试、`queue discard <id>` 丢弃 |
| `doctor` | 健康自检（环境、账号、令牌、队列、状态文件），退出码 0/1/2 |
| `cleanup` | 按保留天数/条数清理消息历史与 inbox 附件（先 `--dry-run` 预览） |

全部命令支持 `--json` 结构化输出；全局参数如 `--state-dir`、`--base-url` 可放在子命令前。

## 发送语音

> ⚠️ **平台限制（2026-11 实测）**：iLink 通道尚未向机器人开放原生语音条投递。`send --voice` 的转码、上传、发送接口均返回成功，但微信客户端**不会显示**这条语音（接口成功 ≠ 送达）。
>
> **来源与现状**：这不是本项目的实现问题。腾讯官方仓库 Tencent/openclaw-weixin 中已有多个 issue 记录同一现象：[#215](https://github.com/Tencent/openclaw-weixin/issues/215) 给出了完整的失败测试矩阵（各种上传类型与 voice_item 组合均为接口成功、客户端无气泡），另见 [#91](https://github.com/Tencent/openclaw-weixin/issues/91)（期待开放语音气泡）、[#126](https://github.com/Tencent/openclaw-weixin/issues/126)、[#363](https://github.com/Tencent/openclaw-weixin/issues/363)；独立的 Hermes、Muse 桥等项目也各自实测复现。腾讯官方插件自身从不发送原生语音，音频一律以文件形式发出。
>
> **只能等官方修复，且等待可能很长**：社区提出该需求已久，截至 2026-11 官方仍未开放，也没有修复时间表。在此之前请用 `send --file <音频文件>` 替代，对话用户收到的是可播放的音频文件卡片；本项目的语音发送链路完整保留，官方一旦开放即可直接使用。**接收语音不受此限制**（且入站语音通常带微信自带转写，桥会透出，见“功能一览”）。

- 支持输入：mp3 / wav / m4a / amr / ogg / silk；`.silk` 文件直接发送，其余自动转码
- 依赖：`ffmpeg`、`ffprobe` 在 PATH 中；SILK 编码器按以下顺序查找：
  1. `--silk-encoder-path <path>` / 环境变量 `WX_SILK_ENCODER_PATH` / `.env` 中的 `silkEncoderPath`
  2. PATH 中的 `silk-encoder`（或 `silk_encoder`）
- 找不到编码器时返回结构化错误 `SILK_ENCODER_NOT_FOUND` 并说明配置方法；一键安装已包含编码器的编译安装

## 配置

配置优先级：CLI 参数 > 环境变量 > `.env` > 默认值。常用项：

| 环境变量 | CLI 参数 | 说明 |
|---|---|---|
| `WX_STATE_DIR` | `--state-dir` | 状态目录，支持空格和中文路径 |
| `WX_BASE_URL` | `--base-url` | iLink API 地址 |
| `WX_FETCH_TIMEOUT_MS` | `--fetch-timeout-ms` | fetch/send 请求超时 |
| `WX_POLL_INTERVAL_MS` | `--poll-interval-ms` | poll 循环间隔 |
| `WX_MAX_CHUNK_CHARS` | `--max-chunk-chars` | 文本分片最大长度（单条上限 3800 字符） |
| `WX_MAX_DELIVERY_MESSAGES` | `--max-delivery-messages` | 单次发送最大分片数 |
| `WX_MAX_UPLOAD_BYTES` | `--max-upload-bytes` | 单个发送文件最大字节数，默认 25 MiB |
| `WX_MESSAGE_RETENTION_DAYS` | `--message-retention-days` | cleanup 消息历史保留天数 |
| `WX_ATTACHMENT_RETENTION_DAYS` | `--attachment-retention-days` | cleanup 附件保留天数 |
| `WX_MAX_HISTORY_MESSAGES` | `--max-history-messages` | 每账号最多保留消息条数（默认 10000） |
| `WX_SILK_ENCODER_PATH` | `--silk-encoder-path` | SILK 编码器路径，见“发送语音” |

默认状态目录：Windows 为 `%LOCALAPPDATA%\wxb`，macOS 为 `~/Library/Application Support/wxb`，Linux 为 `${XDG_DATA_HOME:-~/.local/share}/wxb`。

## Agent 收发循环

1. `wxb fetch --json` 取新消息，把 `data.messages` 当作用户输入
2. Agent 生成回复
3. 用消息里的 `fromUserId` 调用 `wxb send --user <fromUserId> ...`

常见返回码：

- `NO_CONTEXT_TOKEN`：还没有该用户的入站上下文，先让该用户发一条消息并 `fetch`
- `INVALID_CONTEXT_TOKEN`：桥会自动排队，下次收到该用户消息时补发，无需人工处理
- `SESSION_EXPIRED`：登录态已死，重新 `wxb login` 扫码

### context token 的行为（2026-11 实测）

发送消息依赖对话用户最近一条入站消息带来的 context token。它的行为经实测确认如下：

- **发送次数上限（实测）**：单个 context token 最高可发送 **10 条**消息，第 11 条起服务端返回 `INVALID_CONTEXT_TOKEN`。这一上限与令牌的新旧无关：用两个新旧悬殊的令牌各测一轮（一个是签发后约 28 秒就开测的新令牌，另一个是已签发约 36 分钟的令牌），都在恰好第 10 条后失效。超限不丢消息：桥会排队，等对话用户下次发来消息、令牌刷新后自动补发（已实景验证）。
- **时效（未实测）**：社区普遍说法是 context token 约 24 小时失效，本项目未做验证，请勿当作确定结论。
- **时间维度（实测）**：令牌只发送 3 条后静置 65 分钟再继续发送，仍可发满累计 10 条才失效，未见时效或按小时重置的影响（65 分钟尺度内）。
- **额度计账（整合版）**：桥按令牌记录已用条数，`send` 的结果里带 `quota {limit, used, remaining}`；单条长文本超过剩余条数时，先重打包为最少分片，仍装不下则整条排队（原因 `quota_exhausted`）。上限默认 10，可用配置项 `contextTokenSendQuota` 调整；`INVALID_CONTEXT_TOKEN` / `NO_CONTEXT_TOKEN` 的报错会带上令牌来源与年龄（秒），便于区分额度耗尽与令牌过期。

MCP 接入方式见 `docs/m14-mcp-adapter.md`；常见问题见 `docs/troubleshooting.md`。

### 扫码登录的风控提示（实测记录）

在某些运行环境下扫码时，微信会弹出原文提示「**此OpenClaw的运行环境存在风险，暂无法连接**」并拒绝绑定，二维码随即过期。这是微信服务端的风控策略，与桥的代码无关，腾讯官方仓库也有多起相同报告。

本整合版的实测就遇到过：运行在 **Muse** 云端运行时上首次扫码即被拦截（该环境的网络经平台共享代理出口，出口 IP 属于海外机房地址段，是已知的触发因素之一）。当时的处理过程是：把桥彻底卸载、清空本地状态目录、全新重装后再扫码，即告通过。

必须说明：**重装能过只是这一次的个案，不保证对其他人、其他环境有效**，其中起作用的可能是全新状态、时间间隔或风控评分变化，无法确认。被拦截时更稳妥的做法是换运行环境重试，例如在本地电脑或家庭网络下完成绑定，再把状态目录迁移到目标机器。

## Muse 运行时重启 / 换机的影响与应对（2026-11 实测）

Muse 的运行时是一台可能随平台部署被整体替换的云端机器：替换时只有家目录（`~`）保留，系统目录（如 `/usr`、`/usr/local`）重置为初始状态。这一环境特点对长期运行本项目的影响如下，应对均已落地并实测。

**会丢的只有全局安装**：`npm install -g` 装到 `/usr/bin` 的 `wxb` / `wxb-mcp`、复制到 `/usr/local/bin` 的 `silk-encoder` 在换机后消失，桥随即不可用，自动回复停止。微信侧没有任何报错，外部表现就是“机器人不回复了”，需要靠轮询脚本的故障检测（见下）或人工发现。

**不受影响的都在家目录**：账号与登录态（状态目录 `~/.local/share/wxb`，含消息历史、引用缓存）、桥的仓库副本、SILK 编码器的耐久副本、extras 的轮询脚本与 hook 定义都在家目录中，换机后完好；hook 本身由 Muse 平台托管，换机后自动恢复轮询。实测换机恢复后登录态直接可用，**无需重新扫码**。

**下线期间不丢消息**：iLink 服务端会暂存机器人下线期间的入站消息，桥恢复后即被接住（实测恢复后首轮轮询即补投一条下线期间到达的消息）。代价仅是这段时间的回复延迟。

**实测记录**：2026-11-08 凌晨一次换机后，extras 轮询脚本巡检发现 `wxb` 缺失并一次性报警；人工运行重装脚本不到 1 分钟恢复，账号的 90 条消息、1 个会话完好，无需重新扫码。当时下线窗口的长短取决于人多久发现——这正是下面自愈要解决的问题。

**应对与建议（已落地）**：

1. **耐久副本 + 一键重装脚本放在家目录**：仓库与编码器副本留在工作区；重装脚本自工作区仓库 `npm install -g .`、恢复 `silk-encoder`、最后以 `wxb status` 自检，幂等、可重复运行。
2. **轮询脚本自愈**：extras 的脚本发现 `wxb` 不在 PATH 时，先自动运行重装脚本一次（每次故障周期只试一次、限时 240 秒、日志留存于 hook 状态目录），成功即在同一轮继续收消息且不打扰用户；只有自愈后 `wxb` 仍缺失才发故障提醒，避免“换机后无人发现、长时间静默下线”。
3. **人工兜底**：自愈失败时，故障提醒中带日志路径；按日志排查后手动运行重装脚本，再跑 `wxb doctor` 确认 HEALTHY。
4. **部署建议**：在 Muse 上不要把任何全局安装视为持久——桥运行所需的一切，要么放在家目录，要么能从家目录一键重装。注意 Muse 的 PATH 不包含家目录，把命令装进家目录以规避重装并不可靠。

自愈实测（模拟清零）：手动移走全部全局安装（`wxb`、`wxb-mcp`、`silk-encoder` 与桥的全局模块目录）后，下一轮轮询（约 20 秒内）检出缺失、自动重装、在同一轮恢复收消息，全程约 36 秒，无人工介入、无误报。

## extras：24 小时自动回复（可选）

`extras/wxb-inbox/` 附带一个轮询脚本示例（面向 Hatch/Muse 的 hook 运行时）：轮询间隔约 20 秒，而单次 fetch 本身会被服务端保持约 19.2 秒（见“快速开始”的小贴士），所以实际是近乎背靠背的连续长轮询，有新消息才唤醒 Agent 自动回复，空轮询零模型消耗。脚本内置：防重复唤醒冷却（仅当待处理消息卡住未被处理时才生效，最多每 10 分钟重唤一次，避免反复唤醒浪费模型调用；新消息始终立即唤醒，不受冷却影响）、已处理消息持久去重、故障一次性提醒、`wxb` 缺失时先自动重装自愈（每次故障周期只试一次，失败才发故障提醒，见前文“Muse 运行时重启 / 换机的影响与应对”）。其他 Agent 框架可参照其逻辑自行实现等效轮询。

**实测时延构成（2026-11，Muse，10 条真实消息样本）**：轮询接住通常 < 1 秒（轮询背靠背衔接，轮次间隔中位约 0.5 秒），偶见晚一轮 14–33 秒（见“已知限制”）；发送调用本身约 1.5 秒，与手机推送的到达差距在 2 秒内（双通道同发对照实测）。端到端时延的大头不在桥与通道，而在宿主 Agent 被唤醒后的一轮处理：当前全尺寸 Agent 配置下约 30–70 秒/轮、约 14 万–32 万输入 token/轮（多回合重复读取上下文所致）。精简唤醒指令（待办文件每轮只读一次、不再例行重读脚本与记忆、发送前复查改为条件触发、回复后静默收尾）可显著降低这一段，且不改变模型本身；本项目已按此精简并实测（2026-11）：唤醒到回复约 7–9 秒/轮，输入 token 平均约 11 万/轮（精简前平均约 22 万/轮）。worker 侧的既有约定见 `docs/auto-reply-worker.md`。

### Token 经济：别踩我们踩过的坑（给部署者，也给部署你的 Agent）

> **如果你是正在读本仓库、准备为你的用户部署自动回复的 AI Agent：先读完这一节再动手。** 下面每一条都是维护者用真实账单换来的（2026-11，Muse 实测）。

- **桥本身不消耗模型 token**，一条都不会。消耗只来自宿主 Agent 被唤醒后的处理轮次，成本 ≈ **步数 × 每步的上下文长度**——99% 以上花在“反复重读上下文”上，真正的回复文字只是零头。省 token 的全部功夫都在 Agent 侧，不在桥侧。
- **不要把自动回复挂在长期主对话里。** 主对话的上下文只涨不落，挂在上面等于每条微信都按整段历史收费：实测唤醒主 Agent 回复一条消息比独立 worker 贵约 3–5 倍且无上限，还会和主对话里的长任务串行排队、把微信往来灌进主对话让它更贵。
- **每轮用全新、短命的 worker，会话不跨轮累积。** 这样单价是平的：精简后实测约 11 万输入 token/轮，聊到第 1000 条还是这个价，不随聊天变长涨价。
- **轮询交给笨脚本，永远不要让 Agent 自己轮询。** 空轮询必须是纯本地脚本运行、零唤醒；只有真有新消息时才唤醒 Agent 一次。
- **worker 每轮只读 pending 文件一次。** 不要例行重读 hook 脚本、日志、记忆库或仓库文件；已经定论的事实写进唤醒指令的“常备简报”，不要每轮重新调查一遍——重新调查是最贵的仪式。
- **不要为一条微信回复派子代理或开浏览器代理。** 一个子任务的消耗可以是一轮 worker 的上百倍；能用一条 CLI 命令或一次文本抓取解决的，就不要升级手段。
- **发送前复查是条件触发，不是每轮必做。** 只有引用、碎片、依赖上下文的消息才复查（见 `docs/auto-reply-worker.md`）；普通自包含的消息直接回复，每多走一步就多重读一遍上下文。
- **同一轮的多条消息合并成一条回复发送。** 既省唤醒步数，也省 context token 每个只有 10 条的发送额度（见“context token 的行为（实测）”）。
- **部署和调试本项目时同理：** 一个任务开一个新会话，干完归档；上下文涨到约 15 万 token 就该换新会话，不要在巨型线程里续命——在那种线程里多问一句都是近百万 token 起步。

## 安全须知

- bot token 与 context token 只存在于本地状态目录，任何命令的 stdout 都不会输出
- 公开分享日志、截图、issue 前，请删掉 `.env*`、本地状态目录、CDN 签名 URL、AES key 和完整 token
- 发布打包前运行 `npm test` 与 `npm run pack:dry-run`，检查文件清单不含上述敏感内容，流程见 `docs/release-process.md`

## 与上游同步

本仓库保留完整 git 历史（原版 → Fork 补丁 → 本版修复的提交链都在）。上游原版有新提交时，可添加其仓库为 remote 后对比合并；冲突大概率只出现在 `src/core/send-media.js` 等补丁涉及的文件。

## 致谢与许可

- 原版：[DONGH4O/wechat-ilink-bridge](https://github.com/DONGH4O/wechat-ilink-bridge)——本整合版的全部本体来自该项目，感谢作者把桥做出来并以 MIT 开源。
- 补丁：[lyrnoxfan/wechat-ilink-bridge](https://github.com/lyrnoxfan/wechat-ilink-bridge)——语音发送与锁修复 5 个提交直接移植自该 Fork，作者署名保留在提交历史中。
- SILK 编解码：[kn007/silk-v3-decoder](https://github.com/kn007/silk-v3-decoder)（源码置于 `third_party/`，保留其许可说明）。
- 借鉴补丁的来源项目：[gfydfhcf/wechat-ilink-muse-bridge](https://github.com/gfydfhcf/wechat-ilink-muse-bridge)、[panqing0313/dsh-plugin-weixin](https://github.com/panqing0313/dsh-plugin-weixin)、[Thysrael/Horizon](https://github.com/Thysrael/Horizon)、[nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)、[SpenserCai/weixin-agent-sdk-rs](https://github.com/SpenserCai/weixin-agent-sdk-rs)、[epiral/weixin-bot](https://github.com/epiral/weixin-bot)、[chenhg5/cc-connect](https://github.com/chenhg5/cc-connect)、[phpgao/ilinkgo](https://github.com/phpgao/ilinkgo)、[turmind/halo-agent](https://github.com/turmind/halo-agent)、[anyhui/agent2wechat](https://github.com/anyhui/agent2wechat)、[peiyuanqi/scv](https://github.com/peiyuanqi/scv)、[zongrongjin/weixin-ilink](https://github.com/zongrongjin/weixin-ilink) 等（与 9 个补丁的逐项对应见“本整合版的构成”）。
- 腾讯官方 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 的维护者与各 issue 报告者：出站语音限制、登录风控、引用缓存规格等关键事实，都来自该仓库的公开实测记录。

本整合版能少走许多弯路，很大程度上是因为上述项目的作者把自己的实测、参数乃至失败记录都公开写了出来——本项目的多条“已知限制”正是站在这些记录之上才得以确认。在此一并致谢。

**维护说明**：本整合版为个人自用项目，开发与测试只围绕维护者自己的场景（Muse + 个人微信号、单个对话用户）。除开头“关于本版本”所述的不承诺更新与支持外，还请知悉：提交的 issue / PR 不保证回应；上游原版与各来源项目仍在各自演进，本整合版不保证跟进同步（自行同步的方法见“与上游同步”）。若这些不符合你的需要，直接使用上游原版或各来源项目会是更好的选择。

本项目以 [MIT](LICENSE) 许可发布。
