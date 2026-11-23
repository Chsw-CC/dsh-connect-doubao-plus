# 710022004：逆向结论与插件侧对策

## 0. 一句话

`710022004` 不是限流，是字节风控系统（shark）的**滑块人机验证**。插件的 Node 直连在"请求身份"上对不上号，于是被要求验证。
插件不能、也不应该自动过滑块；能修的是两件事——**把请求换到真实浏览器**，以及**把该由人做的那一步做成一键操作**。

## 1. 证据链

| 证据 | 内容 |
|---|---|
| 抓包（M1 §7.1） | `STREAM_ERROR { error_code: 710022004, error_msg: "rate limit" }`，`extra.decision = { from: "shark_admin", type: "verify", subtype: "slide" }` |
| 本地状态（2026-11-23） | `~/.dsh/doubao-risk-circuit.json` = `{"until": 1795407412900}` → 11:16:52 打开、12:16:52 到期（默认 60 分钟熔断） |
| 配置现状 | `~/.dsh/doubao-browser-relay.json` 与 `doubao-browser-fingerprint.json` **都不存在** → 本次走的是 Node 直连，不是官方页面中继 |
| 代码自述 | `doubao-upstream.ts` 顶部注释：UA / Referer / sec-ch-ua 任一错就会把可用会话变成 `710022004 rate limited`；middleware 注释：web cookie + 桌面端 id "正是能触发 710022004 的错配" |

## 2. 为什么会命中（按可能性排序）

1. **身份两半不一致（主因）**。cookie 来自网页扫码登录（web 身份），请求头与 query 却是桌面客户端（`SamanthaDoubao/2.31.4` UA、`chrome://doubao-chat/` Referer、`aid=582478`、`client_platform=pc_client`、`doubao_device_platform=desktop`）。风控比对的正是"会话属于谁"与"请求自称是谁"。
2. **设备指纹是全插件共享的常量**。`device_id / tea_uuid / web_id / fp` 写死在 `CLIENT_PARAMS` 里，公开仓库 → 风控按 `device_id` 聚合时看到的是"同一台设备、大量账号与请求"。
3. **传输层指纹对不上**。Node `fetch`（undici）的 TLS / HTTP2 / 头序与 Chrome 不同；请求头可以改，TLS 指纹改不了——只有真浏览器能对上。
4. **频率是次要因素**。插件已经单并发 + 8 秒间隔 + 60 分钟熔断，正常使用不会因为"发得快"被判定。

## 3. 不能做什么

自动过滑块（打码平台、OCR、轨迹模拟）属于绕过人机验证，且**会让风控更严**（官方提示"反复重试会让验证更严格"）。
本仓库不实现，也不建议接第三方打码。

## 4. 已落地（本次改动）

- **扫码登录时自动抓取网页身份**：`browserLogin` 在同一浏览器、同一时刻记录 UA / Referer / sec-ch-ua / query，写进 `~/.dsh/doubao-browser-fingerprint.json`。新用户零配置；配置与 cookie 天然一致。
- `dsh-connect-doubao-doctor --fingerprint`：老用户补抓一次（或身份过期后重抓）。
- `dsh-connect-doubao-doctor --verify`：用插件自己的浏览器配置（`~/.dsh/doubao-browser-profile`）打开官方页面，由人完成滑块/扫码。
- `dsh-connect-doubao-doctor --resume`：验证完成后清掉本地熔断，下一轮立刻真正发请求。
- `dsh-connect-doubao-doctor --relay on|off`：把普通对话切到官方页面中转（真浏览器自己签名、自己选模型）；任务模式与生图仍走插件自己的通道。
- **本地熔断 ≠ 服务端风控**：`DoubaoUpstreamError.local` 标记"这轮根本没发出去"，文案分别指向 `--resume`（本地）与 `--verify`（服务端）。
- **测试与真实账号隔离**：`tests/setup-env.ts` 注入熔断/节流状态。此前 `npm run check` 会被这台机器真实的 60 分钟熔断与 8 秒节流打成 13 个红，现在 269 例全绿。

## 5. 操作顺序（现在就可用）

```powershell
# 0) 从旧版本升级上来、登录过但没抓过身份：先补一次（新用户扫码时已自动完成）
npx dsh-connect-doubao-doctor --fingerprint

# 1) 仍然被要求验证时，打开官方页面人工完成滑块
npx dsh-connect-doubao-doctor --verify

# 2) 验证完成后解除本地冷却（否则要等到 12:16:52）
npx dsh-connect-doubao-doctor --resume

# 3)（推荐）以后对话都走真实浏览器，从源头不再触发
npx dsh-connect-doubao-doctor --relay on
```

> `--relay on` 需要该 profile 已登录；`--relay on` 发现没有可用浏览器配置时会提示先跑 `--verify`。

## 6. 直连身份对齐（已做）

```powershell
npx dsh-connect-doubao-doctor --fingerprint
```

它连上官方页面（没有就自己开一个，用完关掉），打开 `Network` 域、**reload 一次页面**，然后从页面自己发出的第一条 `www.doubao.com/...?aid=...` 请求上取：

- `User-Agent` / `Referer` / `sec-ch-ua`（页面真实值，不是桌面端常量）
- 完整 query（`aid`、`device_id`、`web_id`、`fp`、`device_platform` …）

写入 `~/.dsh/doubao-browser-fingerprint.json`，`doubao-upstream` 的 `buildHeaders` / `buildQueryUrl` 会**整体替换**桌面端常量。
只 reload、不发消息，不消耗推理额度；`msToken` / `a_bogus` / `web_tab_id` 这类一次性参数会被剔除，绝不落盘。**重启宿主后生效。**

## 7. 相关开关

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `DSH_DOUBAO_BROWSER_RELAY` | 未设 | `1` 强制走官方页面，`0` 强制直连（测试用） |
| `DSH_DOUBAO_RISK_COOLDOWN_MS` | 3600000 | 命中风控后的本地熔断时长，`0` 关闭 |
| `DSH_DOUBAO_MIN_INTERVAL_MS` | 8000 | 直连两次请求的最小间隔 |
| `DSH_DOUBAO_RELAY_DEBUG` | 未设 | `1` 时把中继过程写进 `~/.dsh/doubao-relay-debug.log` |
