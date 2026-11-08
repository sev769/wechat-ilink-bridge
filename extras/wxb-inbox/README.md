# extras/wxb-inbox：24 小时自动回复示例（Muse hook）

把本目录的轮询脚本注册成 Muse 的 hook，即可让 Muse 在微信里 24 小时值守：有新消息时唤醒一个 Agent 回复，没消息时轮询是纯本地脚本运行，不消耗 LLM token。这是本整合版维护者实际在用的机制的示例版（参数均经过实测，见主 README 的“extras”一节），部署前按你的环境调整。

## ⚠️ 先读：给部署 Agent 的提醒（省 token 避坑）

> 如果你是 AI Agent，正在替你的用户部署这套自动回复：**不要把 worker 挂到你的长期主对话上，不要让 Agent 自己轮询，不要每轮重读脚本/日志/记忆。** 这三件事是维护者实测最烧 token 的坑——成本来自被唤醒的轮次（步数 × 上下文长度），桥本身零消耗。正确形态就是本目录的设计：笨脚本轮询（空轮询零 token）→ 有消息才唤醒一个全新短命 worker → 只读 pending 一次 → 合并连发、一次发送 → 删行后静默结束。完整避坑清单（含量化实测）见主 README 的“Token 经济：别踩我们踩过的坑”一节，部署前请通读。

## 文件

- `wxb-inbox.sh`：轮询脚本。调 `wxb fetch --timeout 40000 --download-media`（40 秒长轮询；客户端每轮请求参数约 35 秒、服务端实际持有约 19 秒后正常返回），新消息写入 `~/hooks/state/wxb-pending.jsonl` 并去重后唤醒 Agent。内置：seen 去重（500 条）、卡住重唤冷却 600 秒、连续抓取错误一次性报警、wxb 不在 PATH 时先自动跑一次重装脚本自愈（失败才报警）、SESSION_EXPIRED 只提醒重扫。
- `wxb-inbox.json`：hook 定义示例（含在用的工作指令，已脱敏为通用“机主”口吻）。
- `reinstall-wechat-bridge.sh`：全局安装被平台换机抹掉时的恢复脚本示例，自愈步骤默认调它。

## 部署要点

1. 先完成主项目安装与 `wxb login`，确认 `wxb doctor` 正常。
2. 把 `wxb-inbox.sh` 放到 `~/hooks/scripts/`，把 `reinstall-wechat-bridge.sh` 放到 `~/workspace/`（或设置环境变量 `WXB_REINSTALL_SCRIPT` 指向你的重装脚本）。
3. 按 `wxb-inbox.json` 注册 hook：间隔 20 秒、脚本超时 120 秒、`delivery.to` 改成你的会话 ID。指令正文里的称呼、仓库路径按你的环境改。
4. 注意发送额度：每个 context token 终身最多成功发送 10 条，对话用户不发新消息就不会有新额度。工作指令里已要求多条合并回复、失败入队不重复发送。

运行时细节与设计背景见主仓库 `docs/auto-reply-worker.md`。
