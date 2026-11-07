# 自动回复 worker 的发送前复查合并模式

当用户在 Agent 组织回复期间连发多条补充消息时，逐条各回一条容易答非所问。
gfydfhcf/wechat-ilink-muse-bridge 的做法是：回复发出前再拉一次新消息，合并成
一轮只回一条。本项目在自动回复链路里按同一思路落地，但落点不在桥内核：

## 为什么不在桥内做只读 peek

桥的部署前提是**单轮询者**（见账号锁与 fetch 的实现注释）。一个不推进游标、
不标 seen 的只读 peek 虽然不污染本地状态，但它本身就是第二个并发
getupdates 调用：线上 hook 的长轮询约 19 秒一轮，发送侧的 peek 几乎必然与之
重叠，等于对同一账号双轮询。服务端对并发 getupdates 的游标语义没有可验证
的保证，且本项目的测试约束禁止拿真实账号做这类实验，所以不采用。

## 落点：worker 指令层

自动回复 worker（线上为 hook `wxb-inbox` 的 worker prompt）按以下流程工作：

1. 待回复消息来自轮询脚本写入的 pending 队列。
2. **发送前复查**：worker 在组织回复前，沿正常路径再运行一次
   `wxb fetch --timeout 40000 --download-media --json`。
   - 这是同一个单轮询代码路径（同一游标、同一 seen 机制），不新增轮询者。
   - 同一发送者新到的补充消息与 pending 消息合并成一轮理解，只组织一条
     综合回复。
   - 新查到的消息不在 pending 文件里，回复后无需删行；桥的 seen 记录会
     防止轮询脚本把它们重复投递。
   - 复查 fetch 报错或没有新消息时，按 pending 内容照常处理，不阻塞回复。

worker prompt 的其余约定（逐条删 pending 行、图片/语音处理、SESSION_EXPIRED
停发报告）保持不变。
