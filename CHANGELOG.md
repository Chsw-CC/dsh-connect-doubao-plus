# 更新记录

本文件记录每个发布版本对用户可见的变化。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

---

## 0.18.0 — 2026-11-27

> 同步上游 0.8.3：**直连被风控拒绝时，自动改走官方页面把这一轮答完**。Node 模仿不了浏览器的 TLS / JS 指纹，换一条真浏览器通道比等冷却有用。

### 同步上游（0.8.3）

- **风控自动降级**（`streamChat` 的 `rescueThroughOfficialPage`）：仅当「还没向客户端输出过任何文字」「不是任务模式/生图」「用户没显式关闭中继」「浏览器配置档可用」时生效；成功后清掉本地熔断，下一轮恢复直连。实测：直连被拒 → 自动降级 → 18.2 秒拿到回复。
- **`forceRelay` 作为参数**而非环境变量，降级不会污染并发回合或用户下一轮。
- **中继少一次整页加载**：页面已在 `/chat/` 时不再 `Page.navigate`，省掉约 10 秒（整轮约 14 秒）。
- **`isRiskChallengeFailure`**：区分「服务端滑块」与「本地冷却」——后者根本没发出请求，不构成挑战，也不该触发降级。

### 本仓库（对比取舍与整合）

- **保留 fork 的流式与停止链路**：上游把 `streamChat` 的调用壳重构成 `call(taskMode, forceRelay)`，本仓库在合并时保留了 `visibleContentSent` / `stopGeneration` / `break_stream_msg` 的完整判定，只接入上游的降级分支。
- **`relayEligible()` 收敛三处判断**：本次新增的降级判断与原有的两处「这一轮能否走官方页面」是同一条规则，散在三处迟早会漂移（例如降级去试一个该轮本就禁用的通道）。抽成一个函数，三处共用。

### 测试

- 采纳上游 `tests/risk-fallback.test.ts`（3 例）；全量 **370 通过 / 7 跳过**。

## 0.17.0 — 2026-11-25

> 同步上游 0.8.2，并合入社区 PR #34：**设置卡里的勾选现在真正决定模型下拉框里出现什么**（包括从客户端菜单新发现的 `person-*` 模型），另加内容审核单独归类、任务模式身份统一与直连间隔收紧。

### 同步上游（0.8.2）

- **内容审核单独归类**：豆包的内容审核提示（`涉嫌违反…使用规范` + `反馈与举报`）现在归为 `content_blocked` 并以 HTTP 400 / `CONTENT_BLOCKED` 返回，不进入宿主的重试集合；错误提示直接说明「换一种表达或拆小问题」，并提示反复触发可能导致账号受限。判定刻意收窄（长度上限 + 三段特征同时命中），避免把模型「解释这条提示」的正文误判成拦截。
- **任务模式与对话统一用抓取到的网页身份**：`tool_local` 端点不再另用冻结的桌面身份 —— 会话本身是网页会话，第二个身份只会重复同一个错配。
- **直连最小间隔 8 秒 → 2 秒**：间隔原本是为了在「桌面身份 + 网页 cookie」时期降低滑块概率；身份对齐后单轮上游耗时约 1.7–4 秒，8 秒只会让标题、摘要、重试这类同轮第二请求白等。队列仍是串行。

### 合入的社区 PR

- **#34（lehuaner）模型勾选真正过滤下拉菜单** —— `enabledModelsOf` 删掉了「静态清单里没有的 id 一律保留」这条后门。那条后门本意是让豆包新上线的模型不必等用户重存就能出现，实际效果相反：真实菜单里 11 个 `person-*` id 全不在静态表里，于是每个都免疫自己的勾选框。现在改为严格按勾选过滤。
- **#34 附带的三态语义**（本仓库采纳并保留 `autoCheckin`）：`undefined`=从未保存（服务整份目录，首次安装不会空选择器）、`[]`=保存过「全不选」（真的什么都不提供）、`[a,b]`=只服务这些。区分只在 `withStoredSettings` 做一次 —— 那是唯一还能分辨「宿主的 schema 默认值」与「用户存的值」的地方。
- **#32（FinaleXia）同一缺陷的较小版本** —— 实现与本仓库及 #34 重合，且其用例断言「`[]` 仍服务整份目录」与新三态语义冲突，故 **不单独合并**，其回归思路已由 #34 的用例覆盖。
- **#30（Archettooo）紧凑 @N 工具路由 + ImageX 图片上传 + 附件桥接** —— **本轮不合并**，理由见报告：13 文件 / +1631 行且与本仓库的流式、工具桥接、会话层大面积重叠；引入新的外发域名（`imagex.volcengineapi.com` / `imagex.bytedanceapi.com` / TOS 上传域）与签名逻辑，需单独一轮完整审计；其图片上传把它方凭据类数据（`upload_auth_token`）纳入请求路径。倾向不合并并在下一轮单独评估。

### 修复（合并后暴露）

- **`DOUBAO_MODELS` 与发现目录的分工**：静态表只用于首启兜底与生图别名，勾选过滤一律以「当前目录」为准，不再混用两套清单。
- **`Config` 类型与三态对齐**：schema 的 `enabledModelIds` 默认 `[]` 是宿主占位值，类型上与 `DoubaoSettings` 的 `undefined` 分开声明，避免把占位值当成用户选择。

### 测试

- 采纳上游 `content-moderation` / `identity-unified` 用例，采用 #34 的 `catalog-filter`、`store` 三态用例；全量 **364 通过 / 7 跳过**。

## 0.16.0 — 2026-11-24

> 同步上游 0.8.1：**登录后自动抓取网页请求身份**（不再需要手动配置），额度读取区分「未登录 / 网络异常 / 本地解不开」，并把风控恢复做成命令。本仓库同时保留自己的共享会话层（凭据代际、单飞额度缓存、断流即停、任务工具桥接）。

### 同步上游（0.8.1）

- **登录即抓取请求身份**：扫码成功的同一个浏览器窗口里记录 `User-Agent` / `Referer` / `sec-ch-ua` 与完整 query（`aid`、`device_id` …），写入 `~/.dsh/doubao-browser-fingerprint.json`，之后 Node 直连用同一套身份，避免「网页 cookie + 桌面端伪装」触发 `710022004`。
- **doctor 新增 `identity` 检查**，并新增四个命令：`--fingerprint`（重取身份）、`--verify`（打开官方页面人工过验证）、`--resume`（清本地熔断）、`--relay on|off`（普通对话改由官方页面中转；任务模式与生图仍走插件通道）。
- **额度状态不再误报「会话无法解密」**：区分 `loading` / `signed_out` / `network` / `unreadable`，卡片在额度失败时保留上一次读数并把真实原因显示出来；`fetchQuota` 增加超时、HTTP 200 业务错误码（`710012001` / `710022004`）与空 `data` 判断。
- **登录稳定性**：浏览器查找补用户级 `%LOCALAPPDATA%` 与注册表 `App Paths`；调试端口改为动态分配（不再固定 9333）；DPAPI 优先走 `System.Security.Cryptography.ProtectedData`（`-EncodedCommand`），失败再回退 `crypt32` P/Invoke；cookie 校验统一为核心集合，辅助跟踪 cookie 迟到不再导致「刚扫码就说没登录」。
- **本地熔断与服务端风控分开**：`DoubaoUpstreamError.local` 的文案指向 `--resume`，真正的滑块风控才指向 `--verify`。

### 本仓库（对比取舍）

- **保留 fork 的凭据代际（epoch）**：上游的 `absorbSetCookies` 不带代际，换号前那轮的会话轮换会被重新吸收；合并后每处调用都带上代际。
- **保留 fork 的额度缓存层**：单飞（`inFlight`）与 `peekQuota()` 快照仍在，且**只让缓存型读取加入单飞**——带自定义凭据或自带 signal 的调用是另一个问题，共享答案或共享 abort 都是错的。上游新增的超时、业务错误码、401/403 归类已并入同一实现，`QUOTA_REQUEST_TIMEOUT_MS` 保持单一定义（10 秒）。
- **保留 fork 的流式实现与断流即停**：不并入上游把普通对话重构成 `callOnce` 的写法，`visibleContentSent` 判定、`stopGeneration` / `break_stream_msg` 停止逻辑与任务工具桥接原样保留；只吸收上游的「超大请求体改报溢出」语义（`overflowIfOversized`）。
- **保留 fork 的绝对路径渲染**：上游新增的 `--relay` 已接入，但 agent/relay 身份分支按本仓库结构合并。

### 修复（合并后暴露）

- **`os.homedir()` 在本机 Windows 上的缓存**：Node 在 Windows 上会固定第一次拿到的家目录，于是把 `HOME`/`USERPROFILE` 改到临时目录的调用方（测试、或把宿主放进沙箱的包装层）写盘和读盘落到两个不同位置。新增 `homeDir()`（读环境变量、退回 `homedir()`），auth / 浏览器 / 指纹 / 设置 / 日志 / 镜像缓存 / 熔断状态等所有本插件自己的路径统一走它。
- **卡片额度失败无提示**：`quota.fetchFailed` 文案已存在但从未渲染，补上「额度获取失败：{原因}」一行。

### 测试

- 采纳上游新增用例（中继、指纹、风控、卡片状态、登录/额度修复），并新增 `ws` 作为 devDependency（两个 CDP 用例需要它）。

## 0.15.0 — 2026-11-22
## 0.8.3 — 2026-11-26

> 直连被风控拦住时，插件自己换一条路把这一轮答完，而不是把 710022004 丢给用户。

### 新增

- **命中 710022004 自动改走官方浏览器**：直连被拒时，同一轮自动改由官方页面发出（真实浏览器的 TLS / JS 指纹是 Node 唯一模仿不了的东西）。实测 2026-11-26：直连被拒、同账号经页面正常返回；改完后同一条消息 18.2 秒拿到「Hi～ 你好呀」，用户不再看到风控报错。
- **中继不再每轮重载页面**：只在页面不在对话页时才导航，正常情况下省掉一次整页加载。

### 说明

- 自动降级只对**从未输出过文字**的回合生效，避免重复回答；两条路径都被要求验证时仍会给出「账号级风控」提示并指向 `--verify`。
- 用户显式设置 `DSH_DOUBAO_BROWSER_RELAY=0` 时不做降级（尊重「我就是要直连」）。

---

## 0.8.2 — 2026-11-24

### 修复

- **「工作任务」与对话统一使用同一套网页身份**：此前任务回合保留写死的桌面身份（`aid=582478`、共享 `device_id`、`SamanthaDoubao/2.31.4` UA 与 `chrome://doubao-chat/` Referer），而会话是网页扫码登录拿到的 —— 这正是风控比对的那处不一致。抓到的网页 query 本身就带 `doubao_pc_version` / `samantha_web=1`，所以"任务属于桌面端"的拆分并没有换来协议安全，只多了一套身份。现在对话、任务回合与 `tool_local` 的 ack/complete 端点全部使用抓取到的网页身份；真机跑通一次任务回合（HTTP 200、无 `710022004`），并加了回归用例锁住两条路径的 URL / UA / Referer 一致。
- **直连最小间隔 8s → 2s**：早先的 8 秒间隔是在"桌面身份 + 网页 cookie"的错配下面加的，那时每个请求都可能被要求过滑块。抓到网页身份后，一次普通回合的上游耗时实测只有 1.7–4 秒，8 秒间隔反而让**同一回合里的第二个请求**（标题、摘要、重试）白等最多 8 秒。2 秒仍然串行、也比人打下一句慢。需要更保守可设 `DSH_DOUBAO_MIN_INTERVAL_MS`。
- **内容审核不再被当成「服务端错误」**：`710022004` 是滑块风控，内容审核是另一回事。此前 `STREAM_ERROR` 里的审核文案、以及以回复正文形式返回的审核提示，都会落进通用的 `upstream` 分类，界面提示「豆包返回了错误响应（不是网络问题，重试通常无效）」——用户会以为是服务端故障，而实际要做的是改表述或申诉。现在单独归类为 `content_blocked`：HTTP 400 + 业务码 `CONTENT_BLOCKED`，不进入重试集，文案指向「换一种表达」与「反馈与举报」。识别规则要求同时命中「涉嫌违反 … 使用规范」「反馈与举报」「长按 / 本条消息」且长度 ≤ 200，避免把**解释这条提示**的正常回答误判成拦截（已有 4 例回归）。

---

## 0.8.1 — 2026-11-23

> 让**所有用户**都能正常用：网页身份不再需要手动配置——扫码登录时自动抓取，老用户一条命令补上。同时把 `710022004` 风控的恢复路径做成命令，并把「本地熔断」与「服务端风控」分开说清楚。

### 新增

- **登录即抓取请求身份**：`browserLogin` 在扫码成功的同一个浏览器窗口里记录 `User-Agent` / `Referer` / `sec-ch-ua` / 完整 query（`aid`、`device_id` …），写入 `~/.dsh/doubao-browser-fingerprint.json`。新用户无需任何额外步骤，且身份与其 cookie 天然同源。
- **`doctor` 新增 `identity` 检查**：身份缺失或仍是桌面端（UA 带 `SamanthaDoubao`）会明确报出并给出修复命令。
- **`dsh-connect-doubao-doctor --verify`**：用插件自己的浏览器配置（`~/.dsh/doubao-browser-profile`）打开官方页面，由人完成滑块/扫码。插件不会、也不应自动过滑块。
- **`dsh-connect-doubao-doctor --resume`**：人工验证完成后清除本地风控熔断，下一轮立即真正发请求（否则要等 60 分钟）。
- **`dsh-connect-doubao-doctor --relay on|off`**：把普通对话切到官方页面中转（真实浏览器自己签名、自己选模型）；任务模式与生图仍走插件自己的通道。开启前会检查浏览器配置档是否已有登录 cookie。
- **`dsh-connect-doubao-doctor --fingerprint`**：从官方页面截一条真实请求，把它的 `User-Agent` / `Referer` / `sec-ch-ua` / 完整 query（`aid`、`device_id`、`web_id`、`fp` …）写进 `~/.dsh/doubao-browser-fingerprint.json`，让 Node 直连也用**同一个 web 身份**，而不是"网页 cookie + 桌面端伪装"。只 reload 页面取样，不发消息、不消耗额度；`msToken`/`a_bogus`/`web_tab_id` 会被剔除。

### 修复

- **登录稳定性与浏览器兼容**（`doubao-auth` / `doubao-auth-browser`）：
  - DPAPI 加解密改为优先使用内置 `System.Security.Cryptography.ProtectedData`（`-EncodedCommand`，免去 `%TEMP%` 临时脚本与 `csc.exe` 动态编译，降低被杀毒/策略拦截概率），失败时仍保留原生 `crypt32.dll` P/Invoke 兜底，并补齐子进程所需的 `APPDATA`/`LOCALAPPDATA` 等系统变量。
  - 修复登录等待与读取对 cookie 集合要求不一致的问题：登录捕获阶段会短暂等待并二次读取辅助 cookie，而读取会话仅强制要求核心认证 cookie（`sessionid` / `sessionid_ss` / `sid_tt` / `uid_tt`），避免个别浏览器因辅助跟踪 cookie 未到位而刚扫码就报“还没有浏览器登录态”。
  - 浏览器查找补充用户级 `%LOCALAPPDATA%` 与注册表 `App Paths` 路径；登录改用动态空闲调试端口避开 `9333` 冲突；启动时检测到配置档内旧会话已失效或残缺会自动清理后重新展示登录页；用户主动关闭登录窗也会立即结束等待；重登录成功同时清理内存中的旋转 cookie 缓存（`invalidateRenewals`）。
- **额度读取与状态展示不再误报“会话无法解密”**（`doubao-quota` / `doubao-status` / `DoubaoQuotaCard` / `contract`）：
  - 区分“正在读取额度”（`loading`）、“尚未登录”（`signed_out`）、“路由/网络异常”（`network`）与真正的“DPAPI 解密失败”（`unreadable`）：额度请求未返回或接口报错时不再一律展示“本机保存的会话无法解密，请重新登录一次”，并把真实失败原因显示在额度区。
  - `fetchQuota` 增加 15 秒请求超时、检查 HTTP 200 业务错误码（`710012001` / `710022004` 等）及空 `data`，并把 401/403 归类为 `session_dead`；卡片内额度与统计改为独立并发请求，避免慢网络阻塞统计面板；刷新失败时保留已展示的额度而非清空重置；接口目录探测结果在状态路由内做短缓存，避免无桌面端用户每次轮询阻塞数秒。
- **本地熔断不再冒充服务端风控**：`DoubaoUpstreamError.local` 标记「这一轮根本没发出去」，文案指向 `--resume`；真正的滑块风控才指向 `--verify`。此前两者共用一句「被风控了」，用户会去网页找一个不存在的验证。
- **测试与真实账号状态隔离**（`tests/setup-env.ts`）：熔断状态与 8 秒请求间隔都是生产默认值且持久化，机器上真实命中一次 `710022004` 就会让 `npm run check` 出现 13 个红。现在测试单独注入状态，全量用例与账号状态无关；`DoubaoShim` 也透传自定义 `resolveCredentials` 供隔离测试使用。

### 文档

- **`docs/RISK-CONTROL.md`**：`710022004` 的证据链、触发面（桌面/网页身份错配、写死的共享设备指纹、Node 与 Chrome 的传输层差异）、不能做的事（自动过验证码），以及现在的操作顺序。

---

## 0.8.0 — 2026-11-21

> 同步上游 0.8.0：**「工作任务」模式真正接上 DSH 的工作区工具**。此前任务模式只要请求带工具就整体拒绝，DSH 在该模式下读写不了任何文件；这一版把任务运行时下发的工作区命令桥接成本次请求已声明的 DSH 工具调用，由宿主执行，`finish_reason` 正确变为 `tool_calls`。

### 同步上游（0.8.0）

- **任务模式工具桥接**：`tool_local` 应答器把 `cmd_call` 里的 `operations`（`write_file` / `append_file` / 建目录建空文件）映射为 `write_file` / `append_file` / Bash 等**本次请求声明过**的工具调用交给 DSH 执行。
- **运行时记账本地完成**：`init_agent_workspace` / `append_workspace_trajectory_memory` / `write_workspace_*` 只写 `.sessions/` 前缀内的路径，由插件本地建目录写文件并回成功。判定按**写入路径**而非命令名清单——此前误转交给 DSH，运行时会回「工作区未就绪」并重发同一条命令，形成死循环。
- **PTC 会话**（只声明 `run_code`）：文件操作编译成程序交给 `run_code` 执行，不再整轮拒绝。
- **越界与不可映射一律显式失败**：路径含 `..`、绝对路径、缺少内容、操作数过多都返回失败，绝不伪报成功；失败时向 `~/.dsh/doubao-task.log` 写一行诊断（命令 id、操作、已声明工具、原因），正常回合不落盘。
- **`append_file` 与 `mode: "append"`** 只路由给真正声明了追加语义的工具，绝不降级成覆盖写入。

### 本仓库（保留与适配）

- **保留 fork 的凭据代际（epoch）**：上游的应答器在 `absorbSetCookies` 时不带代际，会接受换号前那轮请求的会话轮换。合并后签名同时接收 `signal` / `epoch` / `declaredTools`，两条路径的语义都在。
- **保留 fork 的流式实现**：上游把 `consumeStream` 加了 `harvestNotifyText` 选项并在任务模式下改变发出时机；本仓库的流式写出与思考链透传已按自己的时序验证过（含断流即停与停止生成），故不并入该选项，任务模式的工具调用仍通过 `toolCalls` 回传。
- **保留 fork 的 `toolEmulation` 默认值**：上游 schema 默认 `true`，与本仓库既有默认一致；`index.ts` 的默认配置对象按本仓库结构保留 `autoCheckin`，同时采纳上游的 `toolEmulation: true`。

### 重构

- **任务桥接诊断抽成 `logTaskBridgeFailure()`**：刚才的合并把「写 stderr + 落盘 `doubao-task.log`」的内联块带进应答器；抽成一个函数，失败路径一处收口。

### 校对

- README（中/英）补上任务模式的两种 `cmd_call` 处置方式（记账本地完成 / 真实操作桥接给 DSH）、越界拒绝规则与诊断日志位置。

## 0.14.0 — 2026-11-19

> 合入社区 PR #21 的 **macOS 模型发现**：此前 macOS 上登录、对话、额度都通了，但模型清单永远回落成 6 条静态条目 —— 因为数据目录探测整段被一个 `platform !== 'win32'` 判断挡住。这一版让 macOS 也能读到客户端菜单缓存。另把两处重复的额度描述拼装收成共享函数。

### 新增

- **macOS 模型发现**（社区贡献，PR #21，作者 [neu-meng](https://github.com/neu-meng)）—— `listDoubaoProfiles` 不再整函数限定 Windows：真正 Windows 专属的两段（`Get-CimInstance` 探测运行中客户端、`C:\` 盘符扫描）单独加条件，darwin 走 AppData 候选路径。
- **macOS 客户端布局**（同 PR）—— `looksLikeProfile` 增加 `Default/Cookies` 与 `Default/Preferences` 两种判定（macOS 版豆包把 cookie 库放在 `Default/Cookies`，没有 `Network` 这一层），`defaultAppDataBases` 在非 Windows 上追加 `~/Library/Application Support/Doubao`。
- **Linux 仍然返回空**：密封与浏览器查找早已按 POSIX 实现，但没有任何一次真机验证过 Linux 版豆包的目录布局，凭空写一个没见过的路径比说「还没验证」更糟。

### 重构

- **额度描述去重**（`doubao-quota`）—— `doctor` 与 `probe` 各自复制了一份「已用 4% / 重置时间未知 / 开始使用后计时」的拼装逻辑，且两处措辞已经漂移。抽出 `quotaResetPhrase()` 与 `quotaAmounts()`，两个 CLI 共用同一份，行为与措辞不变。

### 未采纳

- **PR #22（macOS 登录钥匙串）不合并**：其 `security add-generic-password -w <blob>` 把整段密封会话放进子进程 **argv**，同机任意进程 `ps` 即可在子进程存活期间读到会话；本仓库现有的 AES-256-GCM + 0600 密钥文件路径已在实测中工作，且没有这个暴露面。

### 测试

- 新增 `tests/macos-support.test.ts`（14 条，社区 PR 提供）；其中密封链路与探测分支在 Windows 上按平台跳过（DPAPI 分支不写密钥文件），断言已对齐本仓库实现。

## 0.13.0 — 2026-11-18

> 同步上游 0.7.2 的额度体系改动，并把豆包客户端顶部的「可用额度」汇总搬进卡片：一块只读面板就能看出**还剩多少**，而不只是百分比。

### 新增

- **可用额度汇总**（本仓库自上游 0.7.2 融合）—— 卡片顶部显示套餐积分与活动赠送额度的**剩余合计**，即豆包客户端自己展示的那个数字。它把互不重叠的额度相加，所以在报文里某个窗口只给百分比时**不出数**（返回 null 并隐藏），而不是编一个 0。
  - 兼容 fork 现有模型：窗口仍叫「月度额度」（`window_type: 4`），上游把这同一桶叫「套餐积分」；本仓库沿用「月度额度」措辞，避免与既有设置页、`/quota` 路由和测试里的字段名冲突。
  - `remainingTotal()` 落在 `doubao-quota` 层（与 `findWindow` / `millisUntilReset` 同一处），shim `/quota`、`doctor`、卡片共用同一份计算，不再各自求和。

### 同步上游

- **0.7.2** —— 豆包 2026-11 改版：滚动 5 小时 / 周额度下线，主额度变为套餐积分（`window_type: 4`）。本仓库早已把 4 映射为月度窗口，故本次无需改动映射；采纳的是同一版里新增的「可用额度」汇总与卡片主额度置顶。
- **未采纳上游的 1/2 类型兼容分支**（窗口类型对比见报告）：本仓库 0.11.0 起有意不再建模已下线的 5 小时 / 周窗口，测试也锁死这一行为；重新引入会渲染出永远为空的进度条。

### 校对

- README 额度描述改为「月度额度 + 活动赠送额度 + 顶部可用额度汇总」，与实际卡片一致。

## 0.12.5 — 2026-11-17

### 修复

- **`Doubao stream error 710020202: common invalid param` 在思考模型上不再能自愈** —— 「记住的会话 id 被服务端
  拒绝后，同一 turn 改发新会话」这条兜底原本用一个 `firstTokenAt !== null` 条件把守：一旦已经吐出过任何非空
  增量就放弃重试。而 `firstTokenAt` 是**首字延迟埋点**，思考内容（`reasoning_content`）也会把它置位。
  于是思考型模型先想一段、再被拒，重试就永远不会发生，错误原样抛给用户。
- 工具模拟（`toolEmulation: true`）下更严重：正文在整轮结束前完全不转发，唯一会先到客户端的就是思考内容，
  正好每次都踩中这个条件。
- 现在改用独立的 `visibleContentSent`：只有**正文**真正发给客户端后才阻止重试。思考走单独的
  `reasoning_content` 字段，重发一遍不会让用户看到重复内容；正文已经流出则不重试，因为那确实会造成重复。
- 新增回归测试：构造「先出思考、再报 710020202」的续传轮次，断言仍会改发新会话且用户看不到错误码。
  该测试在旧判定下失败（只发出 2 次上游请求即报错），在新判定下通过（第 3 次改发成功）。

## 0.12.4 — 2026-11-17

### 性能

- **SSE 帧解析由二次降为线性。** 原实现每帧都 `search()` 后 `slice(剩余全部)`，帧越密越慢；
  改为按行单次前扫、空行收帧，只对当前帧的行取子串。实测：单个 200 KB 帧 20.2 ms → 0.3 ms（70×）；
  600 个小帧 / 60 KB 78.2 ms → 38.3 ms（2×）；40 帧 / 10 KB 1.5×。CRLF 与 LF 两种分隔无需分别探测。
- **流式写出按 tick 合并。** 一次读取里的几十帧原先各发一次 `res.write`，每次都要一次系统调用
  加一层分块编码。现在同一 tick 的首条立即写出（不影响首字节），其余合并为一次写入；新增
  `flush()` 并在成功、失败两条 `res.end()` 前调用，避免尾批被丢掉。loopback 实测 5000 个 SSE 块：
  36–54 ms → 2.6–3.3 ms（约 14×）；一轮 1500 个增量大致由 ~11 ms 降到 ~1 ms。
- **额度检查走快照。** 新增 `peekQuota()`：命中缓存时直接返回读数，不再分配 promise，也不再创建
  看门狗定时器——每个对话轮次本来都要建一次。冷缓存仍走 `quotaGate`。
- **模型列表加一条缓存。** `getModels()` 在每次选择器读取与每次派发时都会被调用，原先每次重建
  十几个 `Model` 对象；现在按「地址 + 勾选串 + 目录实例」比对，三者不变即复用。
- **入队不再重复计算字节数。** 每个块的大小在入队时算一次，批量写出时不再逐块 `Buffer.byteLength`。

### 修复（代码审查）

- **额度缓存加入代际号。** `invalidateQuotaCache()` 原先只清读数：换号前发出的请求在落地后仍会写入 `cached`，`peekQuota()` 随后把上一个账号的额度喂给对话闸门，直到 5 分钟 TTL 过期；`inFlight` 也会被后续强制刷新复用。现在失效时递增代际并清空 `inFlight`，旧请求只应答自己的调用方、不写缓存。
- **Cookie 续期加入代际号。** 登录或 `revokeSession` 期间仍在飞的对话/停止请求，落地时会把旧会话的 `msToken`、`bd_sso_hi3jfd` 写回复用表，覆盖刚保存的新会话。现在每个请求记录发起时的代际，代际不符的响应直接丢弃。
- **任务模型标记不再依赖快照。** `catalogSnapshot()` 在发现结果缺失时回退静态清单，只在客户端菜单里出现过的工作任务模型会因此丢掉 `taskMode`，走成普通对话形态。发现层现在单独记住任务模型 id，请求路径在快照缺失时仍能命中。

### 测试

- `tests/stream-sink.test.ts` 增至 7 例：覆盖"首条直写 + 同 tick 合并"、drain 后合并冲刷、
  `flush()` 在半开 socket 上强制交付（防止尾批丢失）、溢出上限。
- 新增 `tests/quota-cache.test.ts`（3 例）：快照返回缓存值且不触网、按 TTL 过期、随失效清空。
- 新增 `tests/quota-generation.test.ts`（2 例）：换号前发出的读数不写缓存、失效后强制刷新不复用旧请求。
- Linux 全量：**32 文件 / 300 通过 / 1 跳过**。

---

## 0.12.3 — 2026-11-17

### 稳定性

- **插件不应能拖垮宿主进程** —— `createServer` 里的 `void handle(req, res)` 一旦产生未处理的
  拒绝，Node 的默认反应是终止整个进程（DSH 随之退出）。现在顶层兜底：捕获后尽力写 500，
  写不出去（头已发送 / socket 已销毁）就静默丢弃。
- **生图缓存不再无界** —— `~/.dsh/doubao-images` 原先只增不删。现在启动时清理（不在请求路径上）：
  删除 30 天前的图片；总量超过 512 MB 时按最旧优先删到上限；废弃的 `.part` 分片 24 小时回收。
  目录可用 `DSH_DOUBAO_IMAGES_DIR` 覆盖。
- **单张图片不再整块进内存** —— 下载改为 `pipeline` 流式写盘，峰值内存降为一个流块；新增 24 MB
  单图上限与单轮 8 张上限（超出部分保留 URL）。先写 `.part` 再 `rename`，失败/超限/超时不留半截文件。
- **长会话的计费估算不再整段重算** —— 每轮都要为整条 transcript 计价，而 Harness 每轮原样重发。
  `estimateTextTokens` 现在对 256 字符以上的文本按内容摘要缓存结果（LRU，4096 条），
  命中路径 1.2 MB 文本 15.0 ms → 2.1 ms（约 7.2×），定价结果不变。

### 性能

- **设置卡轮询由 30 秒改为 90 秒** —— 每次轮询是「强制额度刷新 + 统计」两次请求，30 秒即约
  120 次/小时，而额度一天只变动几百点。90 秒保留"看着是活的"，上游请求降到三分之一；
  切回窗口、手动刷新、领取签到后仍立即更新。

### 测试

- 新增 `tests/image-cache.test.ts`（7 例）：目录覆盖、失败回落、超限拒绝且不留 `.part`、
  单轮 8 张上限、按龄/按量清理、非本插件文件不动。
- 新增 `tests/token-cache.test.ts`（5 例）：重复读取命中、尾部变更不误用缓存、短串不入缓存、
  4 字符/令牌下限不变、容量有界。
- Linux 全量：**31 文件 / 296 通过 / 1 跳过**。

---

## 0.12.2 — 2026-11-17

### 修复

- **重新登录后仍被判为未登录** —— 服务端会把轮换过的 Cookie（`msToken`、`bd_sso_hi3jfd` 等）下发，
  `absorbSetCookies` 记下来并在后续请求里叠加到 `Cookie:` 头上。这批轮换值**从不清理**：扫码
  登录成功后，旧会话的 `sessionid` / `ttwid` 会被叠加到**新**会话的请求头上，服务端只能判定
  登录态依旧失效。现在 `revokeSession()`（会话判死时）与登录成功落盘后都会调用
  `invalidateRenewals()`，两半凭据一起丢弃。
- **外部注入的凭据被上游忽略** —— `createDoubaoShim` 的 `resolveCredentials` 只作用于入站校验，
  真正发请求的 `streamOnce` 仍然自己去 `loadDoubaoCredentials()` 解封一次。现在门禁解出的会话
  直接下传，既让注入源生效，也把每个请求的凭据解封从两次减到一次。
- **同时点两次「登录」会拉起两个浏览器抢同一个配置目录** —— Chromium 对同一 user-data-dir 是独占
  的，第二个进程直接启动失败，且后完成的一个会覆盖先完成的 Cookie。浏览器登录改为单飞（single
  flight），第二次调用等待第一次的结果。
- **macOS / Linux 上手填的客户端目录不生效** —— `candidateProfileDirs()` 只经由
  `listDoubaoProfiles()`（Windows 专属），导致显式指定的目录在其它平台被完全忽略。现在手动目录
  优先于自动探测，挂载/拷贝过来的 `User Data` 在非 Windows 上也能读。

### 性能

- **冷启动与空闲后的首个请求最多白等 10 秒** —— 额度检查位于每个对话请求的关键路径上，
  未命中缓存时会用满 10 秒预算。现在等待上限 1.5 秒（`quotaGate`），读取仍在后台继续填缓存；
  插件启动时预热一次，正常情况零等待。真实「额度耗尽」的提前拒绝保持不变。
- **生图落盘串行、同步写盘、无超时、同秒同名覆盖** —— 四张图从 4 个串行往返（实测 608ms）
  降到并发（实测 165ms）；写文件改走 `fs/promises`，不再阻塞事件循环；每张图 20 秒超时；
  文件名加随机后缀，两个会话同秒出图不再互相覆盖。
- **请求路径上的同步磁盘扫描** —— `requestOptions()` / `describeRequestedModel()` 每请求都调
  `liveModels()`，十分钟 memo 一失效就在请求线程里同步 `JSON.parse` 客户端 Preferences 并整读
  LevelDB 段。新增 `peekModels()` 只取内存快照，把重读留给目录/卡片/定时刷新。
- **LevelDB 扫描增加 24MB 单文件上限** —— 免得某个超大 `.ldb` 在菜单重建时把主线程拖住。
- **流控队列出队由 `shift()` 改游标** —— 2 万块实测 31.9ms → 0.4ms，且不再有 O(n²) 风险。
- **回环服务补 `requestTimeout`（60 秒）** —— 只连不发体的客户端不再占用连接 300 秒。

### 清理

- 删除从未被调用的 `harvestText`；移除 `consumeStream` 上从未被读取的 `harvestNotifyText` 形参。
- `stripPromptEcho` 更名为 `trimLeadingWhitespace`：它只做 `trimStart()`，注释却声称「去掉回显的
  用户提示」，回显真正处理在 `assembleReplyText` 里。
- 订正三处与实现相反的注释：`toolEmulation` 的默认值（schema 为 `true`，仅显式 `false` 才关）、
  `taskMode` 的「DEFAULTS TO TRUE」（实现默认为关，靠「工作任务」模型或 `DSH_DOUBAO_TASK=1` 打开）。

### 测试

- **测试不再依赖「本机刚好已扫码登录」** —— 签到 9 例、`thinking-cot`、用量集成与
  `fixes-regression` 原先直接读真实凭据文件，在 CI 或任何未登录的机器上必然红。签到用例注入
  假会话；`profile` 用例固定 `platform: 'win32'`（该探测本就是 Windows 专属），仅大小写去重用例
  在非 Windows 上跳过。
- 新增 `tests/renewals.test.ts`：钉住「轮换值会被叠加」与「`invalidateRenewals()` 之后必须完全
  消失」这两条契约。
- Linux 全量：**29 文件 / 284 通过 / 1 跳过**（改前 3 文件 / 26 失败）。

---

## 0.12.1 — 2026-11-17

### 修复

- **会话模型选择器里出现设置中未勾选的模型** —— `enabledModelsOf` 原本对「静态目录里不认识的 id」
  无条件放行：过滤条件是 `wanted.has(id) || !known.has(id)`，后半个条件本意是「豆包新上线的模型别
  因为用户没勾过就藏起来」，实际效果却是把发现到的真菜单里 7 个静态目录没有的 id 全部豁免了勾选。
  于是设置页取消勾选 Kimi / GLM / DeepSeek 完全不生效，选择器照旧全部列出。现在过滤只看勾选列表。
- **首次安装不会因此变空** —— 卡片从刚读到的目录铸造草稿，新 id 一进来就是勾上的，只有用户主动
  取消才会消失。这是原来那半个条件的正当意图，由卡片而不是由过滤器承担。
- 同时移除该函数里已失效的 `known` 集合与描述旧行为的过时注释，并补 7 个断言钉住这四种情形：
  未配置、空选择、勾选生效、勾选里含目录已下线的 id。

## 0.12.0 — 2026-11-17

### 新增

- **每日签到** —— 卡片新增一节：连签天数、今日是否已领、`领取今日额度` 按钮。走豆包活动接口
  `POST /alice/ug/campaign/v3/detail/` 读状态、`POST /alice/ug/campaign/landing/checkin` 领取；
  服务端**幂等**（重复领返回 `idempotent: true`，不会双领），按钮连点也只是空操作。
- **每天自动签到**（卡片开关，默认**关闭**） —— 按**北京时间日界**每天最多领一次。失败下一轮重试
  （10 分钟一跳）；`登录过期` / `无此活动` 不重试，因为重试一万次也不会变。
- **独立降级** —— 签到是加值功能：单独模块 `src/doubao-checkin.ts`、单独路由、单独请求，模块内
无任何 `throw`。接口改版只让这一节显示失败原因，**对话、生图、额度面板不受影响**。

### 说明（实测 2026-11-17）

- 活动接口的查询参数**与对话链路不同**：`aid` 是 `497858`（对话是 `582478`），另外多了 `doubao_pc_version`。用对话参数会得到 HTTP 200 + `code: 1` + 空响应体，看起来像「这个账号没有活动」，其实是参数用错了。只有请求头可以复用 `buildHeaders()`。
- `710012001` 表示登录过期（提示重新扫码）；`710010702` 表示该账号没有签到活动（企业 / 飞书账号），后者按 `no_task` 提示，不算失败。

## 0.11.0 — 2026-11-17

> 流式链路与辅助请求的稳定性加固：上下游两侧都补上了缺失的上界。

### 修复

- **SSE 输出不再无上限缓冲**：`res.write()` 返回 `false` 表示套接字缓冲已满，此前一律忽略。
  客户端读取慢于豆包产出时（窗口被挂起、调试器断点、宿主自己忙），Node 会把本轮剩余内容
  全部堆进内存且没有任何征兆。现在超出的部分进入有界队列并在 `drain` 时按序补发；
  队列超过 4 MB 直接中止本轮并给出可读原因，而不是把宿主堆吃光。
- **静默期不再看起来像断连**：豆包思考期间定期发送 SSE 注释行（`: keepalive`），
  刷新客户端自己的空闲计时器并阻止中间网络元件回收连接。注释行是标准 SSE 空操作，
  OpenAI SDK 的解码器直接丢弃，不会产生额外 chunk。插件自身的 5 分钟看门狗保持不变，
  仍会在豆包真的不返回时中止 —— 以前两个 300 秒超时会同时到期，产生两条互相矛盾的消息。
- **额度接口有 deadline 且并发请求合并**：额度读取位于每个对话请求的关键路径上，此前既无超时
  也无去重。现在 10 秒未响应即放弃（并给出「豆包额度接口 10 秒未响应」），同一时刻的多个
  调用合成为一次请求（缓存只在响应落地后才写入，所以此前突发的第一秒是 N 次请求）。
- **模型目录接口有 deadline**：15 秒未响应即回落到缓存/静态清单，而不是让模型选择器一直转圈。

### 性能

- **回合之间复用连接**：本地回环 HTTP 服务的 `keepAliveTimeout` 从 Node 默认 5 秒提到 65 秒
  （`headersTimeout` 66 秒）。此前对话中自然的思考停顿会丢掉一条本可复用的连接，
  下一回合重新付一次握手。
- **关闭 Nagle**：SSE 响应套接字设 `setNoDelay(true)`，20 字节级的增量不再等待凑满一个报文段。

## 0.10.2 — 2026-11-17

### 修复

- **会话模型选择器与设置页勾选不一致**：在设置页取消勾选某些模型后，对话输入框的模型列表
  仍会列出全部模型（包括已取消勾选的）。原因是宿主在设置变更时会广播它自己那份配置
  （本插件的配置项在宿主里永远读不到，见 0.5.0 说明），插件照单全收地把内存里的勾选
  重置成了空列表 —— 而空列表被解释成「从未配置过」，于是选择器放出了整个目录。
  现在设置变更一律**重新读取插件自己的设置文件**，保存路由与宿主事件走同一条路径，
  两条通道不会再分叉。
- `scripts/check-locale-literals.mjs` 的必备键从 `quota.weekly` 换成 `quota.monthly`
  （上一版移除周额度后该守卫会误报）。

## 0.10.1 — 2026-11-16

> 精简额度面板：移除 5 小时限额与周额度。

### 变更

- **删除 `fiveHour` / `weekly` 窗口**：`QuotaWindowType` 收敛为 `monthly | incentive`，
  `window_type 1` / `2` 不再建模。豆包当前套餐只下发月度窗口（window_type 4），
  这两条进度条此前一直为空，留着只会让人误以为数据坏了。
- `/quota` 路由、shim 镜像、`doctor` / `probe` 输出与客户端卡片同步移除这两个窗口；
  若豆包未来恢复下发 1/2 类窗口，面板不会显示（有意为之，见 `doubao-quota.ts` 注释）。
- 若你的账号仍能看到 5 小时 / 周额度并希望恢复展示，请开 issue 说明套餐类型。

## 0.10.0 — 2026-11-16

> 豆包改版适配：免费体验套餐的限额窗口从「5 小时 + 周」改为**单个月度窗口**（window_type 4）。

### 新增

- **月度额度窗口**：`window_type 4` 映射为 `monthly`，额度看板新增「月度额度 / Monthly quota」进度条，
  含已用百分比与重置倒计时；`/quota` 路由、shim 镜像与 `doctor` / `probe` 输出同步透传。
  5 小时与周额度条保留，仍在下发这两类窗口的账号不受影响。

### 修复

- **登录态迁移**：0.4.x 遗留的 `doubao-credentials.dpapi` 密封缓存（0.5.0 起废弃不再读取）中
  仍有效的浏览器会话被恢复到当前的 `doubao-credentials-browser.dpapi`，老用户无需重新扫码。

> 更名版本：fork 从 `dsh-connect-doubao` 改为 **`dsh-connect-doubao-plus`**，
> 仓库同步改为 [Chsw-CC/dsh-connect-doubao-plus](https://github.com/Chsw-CC/dsh-connect-doubao-plus)，
> 并投稿到 awesome-dsh-plugin 插件市场。

### 变更

- **包名 / 插件 id 改为 `dsh-connect-doubao-plus`**：`package.json` 的 `name` / `displayName` /
  三个 `bin` 入口、`cordis.patch.yml` 的 `id` 与 `name`、`PLUGIN_ID`、客户端 `name` 与
  locale 命名空间、只读路由 `/plugins/dsh-connect-doubao-plus/*`、设置页 section id、
  客户端 bundle 的 `__ModuleLoader__.load({ id })` 全部一起改，避免宿主里出现两套 id。
- **仓库元数据指向本 fork**：`repository` / `homepage` / `bugs` 不再是上游
  `Wahwayhale/dsh-connect-doubao`；上游署名（fork 说明、贡献者列表）原样保留。
- **不迁移本地数据**：设置文件仍是 `~/.dsh/dsh-connect-doubao.settings.json`，凭据与生图缓存
  路径不变 —— 升级不需要重新扫码登录，已有设置不会丢。
- **安装说明改写**：本仓库不发 npm；`prepack` 依赖 `npm`，而 Harness 内置运行时只有 `node`，
  因此 git 地址直装会在 prepare 阶段失败。README 改为 GitHub Release tarball 与本地源码目录两种方式。

## 0.8.0 — 2026-11-15

> 同步上游 0.7.0 / 0.7.1，合入社区 PR #12（macOS / Linux 浏览器扫码登录，关联 issue #10），
> 并加入本仓库自有修复：会话续传加固与流中断即停。

### 新增（本仓库）

- **流被掐断即停豆包端生成**（`doubao-shim`）：客户端断开、空闲看门狗、710020202 同turn回退
  触发 abort 时调用网页端 `break_stream_msg`（cmd 2240, break_reason=7），按 `conversation_id` +
  `question_id` 停掉本轮服务端生成，旧线程不再空转烧积分；独立 5s 超时、fire-and-forget。
- **同turn回退被拒续传**：被拒的 conversation id 不再复用（改发前先停被拒线程），同一 turn 内
  改发新会话完成续传；连续三次上游失败触发**熔断阀**，会话记忆有效期收敛为 7 天（`SESSION_TTL_MS`）。

### 同步上游

- **0.7.0**：在线菜单模型发现、对话框计费倍率展示、逐模型思考档位、思考链（CoT）推理透传、
  原生 Token 用量与会话统计。
- **0.7.1**：工具模拟默认开启、解析加固与多轮上下文修复；生图直取无水印原图。

### 跨平台登录（社区 PR #12）

#### 新增

- **跨平台会话密封**（`doubao-auth`）：Windows 继续用 DPAPI；macOS / Linux 改用 AES-256-GCM，
  密钥存于 `~/.dsh/doubao-credentials.key`（0600），密封文件带 `DSHD1:` 版本标记。
- **跨平台浏览器查找**（`doubao-auth-browser`）：`findBrowser()` 按 `process.platform` 选择候选
  （macOS `.app` 包 / Linux 可执行文件），并支持 `DSH_DOUBAO_CHROME` 显式指定任意 Chromium 二进制。

#### 修复

- **POSIX 上登录浏览器残留**（`doubao-auth-browser`）：原 `terminate()` 用 `taskkill`，而
  `spawnSync` 在 ENOENT 时不抛异常，导致 `child.kill()` 兜底从不执行、调试端口 9333 被占用。
  现按平台分支，非 Windows 直接 `SIGTERM`。

#### 测试

- 新增 `tests/macos-compat.test.ts`：覆盖 `DSH_DOUBAO_CHROME` 覆盖、`terminate()` 平台分支，
  以及隔离 HOME 下的 AES-256-GCM 密封往返与篡改拒绝。

## 0.7.1 — 2026-11-14

> 这一版把「提示词模拟工具调用」从实验性默认关闭改为**默认开启**，并加固了解析与多轮上下文，让豆包及客户端接入的第三方模型（DeepSeek / Kimi / GLM 等）开箱即能驱动 DSH 的本地工具。

### 变更

- **工具模拟默认开启**（`doubao-config` / `doubao-shim`）：`toolEmulation` 默认值由 `false` 改为 `true`，`toolEmulationOf` 改为「除非显式设为 `false` 否则开启」，shim 的 `emulationOn` 回退同步改为 `true`。新装用户无需手动打开开关，即可让豆包通过 OpenAI `tools` → `doubao-tool` 围栏 → `tool_calls` 的转译调用本地工具。设置页文案同步更新，去掉「实验性 / 默认关闭」措辞。

### 修复与加固

- **工具调用解析支持更多形态**（`doubao-tools`）：
  - 单个围栏内的 **JSON 数组**（一次并行多个工具调用）现在会被全部解析，而不再只取第一个。
  - 兼容 **OpenAI 嵌套结构** `{"type":"function","function":{"name":...,"arguments":...}}`。
  - 新增 ```json 围栏回退：当模型改用 ```json 输出严格包含 `name` 与 `arguments`/`params` 的对象（或数组）时也能识别并转译为标准 `tool_calls`；非工具形状的普通 JSON 代码块保持原样不误吞。
- **多轮工具调用上下文不再丢失**（`doubao-shim`）：`buildPrompt` 展开历史消息时，若 `assistant` 消息正文为空但带有 `tool_calls`，此前会被整条跳过；现在会把它还原为 ```doubao-tool 围栏拼回上下文，与随后的 `[tool result]` 正确配对，避免续接轮里模型「忘记」自己刚发起过哪个调用。参数为已解析对象或非法 JSON 字符串时均做了安全兜底。

### 测试与校验

- 新增解析回归：JSON 数组多调用、OpenAI `function` 包装、```json 围栏回退各一例。
- 更新默认值断言：`toolEmulation` 默认应为 `true`。
- 新增 `vitest.config.ts`，把测试范围限定在 `tests/`，避免误扫本机克隆的市场仓库（`awesome-dsh-plugin/`）里不相干的脚本。

---

## 0.7.0 — 2026-11-13

> 这一版补齐了在线模型发现链路，把思考链（CoT）、对话框模型倍率展示、以及 DSH 原生 Token 用量与会话统计全部接了进来。

### 新增

- **对话框模型选择倍率与对比弹窗**（`DoubaoRateControls` / `DoubaoCatalogStore`）
  - 接入 DSH 对话框插槽 `conversation.input.model.label` 与 `conversation.input.right`，在模型下拉选项中直接显示豆包模型计费倍率与活动优惠标签，在输入框右侧提供当前倍率胶囊控件。
  - 点击输入框右侧倍率控件可弹出所有已发现豆包模型的倍率对比面板，并支持手动强制刷新目录；非 Doubao 供应商保持宿主原有徽标与渲染样式不变。
- **思考链（深度思考 CoT）完整接入**（`doubao-upstream` / `doubao-shim`）
  - 完善 `block_type: 10040` 思考容器、`parent_id` 思考子块、`text_block.summary` 摘要式推理、无 `id` 的 `CHUNK_DELTA` 状态追踪路由（`BlockCollectState`），以及占位标题过滤与 `STREAM_MSG_NOTIFY` 回放去重，确保思考过程完整输出到 OpenAI `reasoning_content` 与 DSH `reasoning-delta`。
  - 支持普通对话模型传入 `reasoning_effort: "off"` 显式关闭深度思考；「工作任务」模型首轮默认携带 `conversation_mode: "2"`。
- **DSH 原生 Token 用量与会话统计**（`doubao-tokens` / `doubao-stats` / `DoubaoQuotaCard`）
  - 为 `/v1/chat/completions` 流式（含 `stream_options.include_usage: false` 控制）与非流式响应生成确定性 OpenAI `usage`（满足 DSH `TokenMeter` 4 字符/token 下限要求，多轮 `conversation_id` 续接前缀记入 `prompt_tokens_details.cached_tokens`，思考过程记入 `completion_tokens_details.reasoning_tokens`，兼容模拟工具调用词元统计），直接驱动 DSH 顶部/状态栏 Token 用量与会话统计。
  - 在 `doubao-upstream` 解析任务轮次上游上报的 `context_window_usage`、`tea_tags_time_cost`（`ack_cost_time` / `first_packet_cost_time`）、`finish_time_ms` 与 `finish_reason_chat`。
  - 新增内存统计收集器 `DoubaoStatsTracker`（最多保留 64 个不透明会话键，不记录提示词/凭据原文）与路由 `GET|POST /plugins/dsh-connect-doubao/stats`（支持带 `x-dsh-doubao-write` 校验头的清零操作），并在插件设置页新增「会话统计与 Token 用量」面板展示请求数、续接数、Token 细分、缓存命中率、平均 TTFT、生成速率（tok/s）及最近一轮上游窗口拆解。

### 修复

- **在线模型发现与刷新联动**（`doubao-discovery` / `doubao-status`）：新增 `POST /alice/slot/action_bar_v3/brief_list` 在线菜单解析（支持 `menu_conf_v2` 与 `menu_conf` 回退）、多 Profile 目录候选扫描及遍历所有 `BriefListRequestCache` 键；点击「刷新」或完成浏览器扫码重登录后自动触发在线刷新并重建适配器模型列表。
- **端口绑定通知与勾选列表初始化**（`doubao-adapter` / `index`）：新增 `onBaseUrlReady` 回调在 shim 端口就绪后通知宿主刷新可用路由，并使用合并后的 `current`（而非 Loader 原始配置）初始化 `enabledModelIds`。
- **额度耗尽判定误拦截**（`doubao-quota`）：通过 `evaluateQuotaExhausted` 仅在所有有效额度分组都耗尽时才判定账号额度用完，避免活动赠送额度用尽误拦常规 5 小时/周额度请求。
- **生图路由隔离与提示词清理**（`doubao-shim` / `doubao-upstream`）：`image-gen`（兼容大小写与 `doubao/` 前缀）强制关闭深度思考、跳过工具模拟与多轮上下文续接；`buildImagePrompt` 放宽描述上限至 2000 字符并清理 `<system-reminder>`、`<hindsight_page_refresh>` 及框架上下文注入文本；无水印原图缺失时支持回退 `image_ori`。

### 测试与校验

- 新增思维链、倍率控件、Token 估算、会话统计路由与设置页卡片、以及通过 `@deepseek-ai/dsh-llm-pi-ai`（`PiAiAdapter`）真实串联 loopback shim 的端到端集成测试，覆盖流式/非流式、多轮缓存增长与模拟工具调用。

---

## 0.6.1 — 2026-11-12

> 这一版把「模型清单」从一张硬编码表，改成照抄豆包客户端菜单：有什么模型、各自多少倍率、
> 各自支持哪几档思考强度，全部实时读出来。三处缺陷叠在一起，任何一处单修都看不出效果。

### 修复

- **清单读错了缓存目录** —— `CACHE_DB_DIRS` 只列了 `chrome_doubao-launcher_0`，该库最后
  一次写入是 2026-09-17，插件于是永远只看到 `0/3/4/5/9` 五条，而客户端菜单早已列出十二条。
  现在优先读 `Default/Preferences` 里的 `saman.local_storage_for_web['frontend-request-cache']`
  （应用每次刷新菜单都会重写，是唯一还保持最新的源），IndexedDB 退为兜底，并补上
  `chrome_doubao-chat_0`。
- **键名校验卡掉了新模型** —— `looksLikeModelKey` 原为 `/^[\w-]{1,24}$/`，而第三方模型键长
  27–37（`person-kimi-k3-1-pro-highspeed-261111` 是 37 字符），于是 Kimi 高速 / GLM Flash /
  DeepSeek V4 系列被逐条丢弃。改为按形状校验、长度上限 64。
- **刷新按钮其实不刷新** —— 卡片的「刷新」发的是 GET，而清 memo 的分支挂在 POST 上，于是它把
  十分钟前的 memo 原样又画了一遍。改为 POST（带 `x-dsh-doubao-write` 头），现在点一次就真重读。
- **极高 / 最高 根本发不出去** —— shim 的 `toDoubaoLevel` 只认 low/mid/high，序号 6 和 7 被静默
  夹到「高」，DeepSeek / Kimi / 2.1 Max 的上半档等于不存在。现在 6/7 直通。
- **档位顺序被排序打乱** —— 「自动」声明的是 低(3) / 中(8) / 高(5)，按数值排序会把「高」排成
  中间档、8 排成最强档。改为保留菜单顺序。
- **非标准档位被吞掉** —— `findReasoningLevel` 以前只认三个名字，序号 8 会退回「高」；现在未知
  序号原样透传成一个临时档位，不会把用户选的那个换掉。

### 新增

- **倍率 / 优惠标签** —— 读客户端菜单的 `tag_list` 原样显示：`0.65x`、`0.46x` 这类是倍率，
  `限时优惠 0.01x`、`小额免费` 这类是活动标签（描边样式区分，避免活动价被当成常价）。
  卡片同时注明「倍率来自客户端菜单，本插件不参与计费，也无法核对实际扣费」。
- **每个模型自己的思考档位** —— 菜单的 `reasoning_effort_config.option_list` 是逐模型的，而且
  不统一：GLM 只有 低/高/最高（3/5/7），2.1 Lite 是 低/中/高（3/4/5）。以前统一用目录里那三档，
  等于对 GLM 承诺了一个它没开的「中」。现在按模型自己的阶梯渲染，`thinkingLevelMap` 也据此生成。
- **档位验证标记** —— 实测过的档位（3/4/5）实线；只在菜单里声明、还没在真实请求中验证的
  （6 极高 / 7 最高）虚线，tooltip 里写明。

### 其它

- 新模型按 `default_mode` 归入对应模式：`mode_id: "3"` 的第三方模型走「工作任务」
  （`agent_mode 1` / `conversation_mode 2` / `need_deep_think 10001`），不会被当成普通对话。
- `findDoubaoModel` 对未见过的键改为原样透传，新增 `isKnownModelId` 区分「没有显示名」与
  「不存在」——否则新模型会被静默换成豆包快速。
- `toPiModel` 的 `thinkingLevelMap` 按模型阶梯生成：`xhigh` / `max` 只在模型真有这两档时给出
  映射，否则为 `null`（pi-ai 把 `null` 读成「不提供」，而不是夹到相邻档）。
- 卡片里的 `requested_model` 优先显示客户端原名。
- 新增回归测试：长 `person-*` 键必须能解析、超长与含空格的键必须被拒、6/7 档位、未知序号透传、
  逐模型阶梯、倍率原样保留。

---

## 0.6.0 — 2026-11-11

> 模型清单从「只认五个老模型」修成「客户端菜单有什么就显示什么」。三处缺陷叠在一起，
> 任何一处单修都看不出效果。

### 修复

- **清单读错了缓存目录**：`CACHE_DB_DIRS` 只列了 `chrome_doubao-launcher_0`，该库最后一次
  写入是 2026-09-17，插件于是永远只看到 `0/3/4/5/9` 五条，而客户端菜单早已列出十二条。
  现在优先读 `Default/Preferences` 里的 `saman.local_storage_for_web['frontend-request-cache']`
  （应用每次刷新菜单都会重写，是唯一还保持最新的源），IndexedDB 退为兜底，并补上
  `chrome_doubao-chat_0`。
- **键名校验卡掉了新模型**：`looksLikeModelKey` 原为 `/^[\w-]{1,24}$/`，而第三方模型键长
  27–37（`person-kimi-k3-1-pro-highspeed-261111` 37 字符），于是 Kimi 高速 / GLM Flash /
  DeepSeek V4 系列被逐条丢弃。改为按形状校验、长度上限 64。
- **刷新按钮其实不刷新**：卡片的「刷新」发的是 GET，而清 memo 的分支挂在 POST 上，
  于是它把十年前的 memo 原样又画了一遍。改为 POST（带 `x-dsh-doubao-write`），
  现在点一次就真重读缓存。

### 其它

- 新模型按 `default_mode` 归入对应模式：`mode_id: "3"` 的第三方模型走「工作任务」
  （`agent_mode 1` / `conversation_mode 2` / `need_deep_think 10001`），不会被当成普通对话。
- `findDoubaoModel` 对未见过的键改为原样透传 + `isKnownModelId` 区分「没名字」与「不存在」，
  否则新模型会被静默换成豆包快速。
- 卡片里的 `requested_model` 优先显示客户端原名。
- 新增回归测试：长 `person-*` 键必须能解析、超长与含空格的键必须被拒。

---
## 0.6.0 — 2026-11-11

> 生图这条路从「能出图」修到「在对话框里直接看到对的图」。三处都是实测出来的，不是推断。

### 修复

- **无水印**：生图回复里同时带着 `image_ori`（右下角有「豆包AI生成」）和 `image_ori_raw`
  （原图）。原来取 `image_ori`，所以每张图都带 logo。现在优先 `image_ori_raw`，取不到才回落，
  账号没开无水印档位时行为不变。
- **提示词不再被框架文本污染**：DSH 一轮请求会带 7 条 message——开发者提示、运行时快照、
  技能目录、MCP 列表、记忆页面——真正的用户描述夹在其中。原来取「最后一条 user 消息」，
  拿到的是 `<system-reminder>` 块，于是豆包把 `turn 1 step 1`、工具名当成画面内容画了出来
  （用户看到的 “1turn / tup / tun” 残影）。现在按三条标准筛：长度 ≤600 字符、不以 `<` 开头、
  不含已知框架标记。
- **自动补「生成图片：」前缀**：桌面客户端靠 `chat_ability.ability_param.reply_message_format`
  改写正文，外部客户端没有这个钩子，服务端会把请求当普通对话回答。`withImagePrefix()` 补上
  同样的改写；已有前缀不重复加，普通对话完全不受影响。
- **模型 id 宽松匹配**：DSH 可能带 provider 前缀（`doubao/image-gen`）或大小写不同，
  漏判会静默回落到完整 agent 提示词——这正是提示词被污染的另一半原因。

### 其它

- 生图版本名改为读插件根目录的 `image-models.json`（缺省 Seedream 5.5）。该文件由
  `doubao_imagemodels.py --sync` 从服务端 `get_item_conf` 生成，服务端上新版本后改数据即可，
  不用改代码。
- 新增 `DSH_DOUBAO_DEBUG_PROMPT=1`：把实际发出的 prompt 与原始 messages 结构打到 stderr，
  并追加到 `~/.dsh/doubao-prompt.log`。默认关闭。
- 新增测试：无水印变体选择、前缀注入（含幂等与普通对话不受影响）。

---

## 0.5.0 — 2026-11-07

> 取凭据的路只剩一条：**浏览器扫码登录**。上一轮加的 `authMode` 开关（客户端 / 浏览器）
> 连同它背后的「解密豆包客户端 cookie」整条路径一起删掉 —— 不是弃用，是移除。理由是那条
> 路径有个从外面修不好的缺陷：豆包客户端运行时对 `Default\Network\Cookies` 持**独占锁**，
> 而本插件恰恰是为「客户端正在运行」的账号准备的；读不到就回退到 12 小时前的密封副本，
> 服务端早已轮换会话，于是每个请求都被上游拒绝，本地状态却还显示「已登录」——用户既看不
> 出问题也修不了。浏览器扫码没有这个死结：cookie 当场抓到、当场密封，不存在更旧的副本。
> 已登录的浏览器会话**不受影响**（密封文件名沿用 `doubao-credentials-browser.dpapi`）。

### 破坏性变更

- **登录方式只剩「浏览器扫码登录」** —— 删除 `authMode` 设置项（config schema、自带设置文件、
  路由、卡片单选、中英文案），插件永远读浏览器会话，没有第二个选项可选。
- **删除 `/plugins/dsh-connect-doubao/profile` 路由与卡片里的「豆包数据目录」整节** ——
  客户端 profile 选择器已无意义；保存路由的写入白名单同步去掉 `profileDir`，避免出现
  「写进了磁盘但直到重启才生效」的半截状态。数据目录仍可通过设置文件的 `profileDir`
  或环境变量 `DSH_DOUBAO_PROFILE` 指定，它现在只用于模型清单缓存与任务模式工作区。

### 移除

- `decryptFromProfile`、`decodeCookiePlaintext`、`decryptCookieValue`、SQLite 读取与
  多 profile 回退（`loadDoubaoCredentials` 不再遍历候选，也不再做 stale-while-error）。
- 12 小时密封缓存 `~/.dsh/doubao-credentials.dpapi`（`CREDENTIAL_CACHE_FILENAME` /
  `saveCredentialCache` / `loadCredentialCache`）。**老版本留下的这个文件不再被读取**，
  可以手工删除；留着也不会被当成登录态。

### 修复

- **账号状态把「未登录」误判成「网络失败」** —— 无登录态时的提示文案是中文，客户端
  的状态分类只匹配英文关键字，于是回落成「连接豆包失败：请检查网络」。现在中文的
  登录态/风控文案也参与分类。
- **卡片与文档不再声称「复用客户端登录态」** —— 副标题、账号状态文案、README 中英两版
  的前置条件、工作原理、平台支持、已知限制全部改成浏览器扫码，并写明不再解密客户端 cookie
  的原因。

### 思考（同批）

- **深度思考默认开启** —— 以前每轮都是普通回合（`need_deep_think: 0`），模型选择器的
  低/中/高只改 `reasoning_effort`，对思考没有任何作用。现在非「工作任务」模型发
  `need_deep_think: 3` + `ext.use_deep_think: "3"`；「工作任务」模型（Lite / Pro / 自动）
  保持官方客户端抓到的真实形态 `10001`。因为任务模型的形态是靠 `deepThink === undefined`
  区分的，shim 对它们特意**不传**布尔值，否则会被降级成聊天形态。
- **「豆包 快速」标记为不可推理** —— 实测深度思考全开、档位拉到高，它仍返回
  `thinking: false` 且流里没有 `10040` 容器；同一请求换 2.1 Pro 立刻变 `thinking: true`。
  于是它不再出现在推理档位的可选范围里，卡片清单也不再给它列低/中/高。发现路径也要
  应用这条：客户端菜单把每条都标成可推理，所以判断放在发现之后，按实测清单收口。
- **不再谎报「选了档位就会思考」** —— 这是上面两条要一起改的原因：只改开关不改挡位，
  或只改挡位不改开关，都仍然看不到思考。

> **思考正文仍然看不到，这是接口限制。** 2026-11-07 在官方客户端打开深度思考发一条真实
> 消息并抓包对照：请求是 `need_deep_think: 10001`，响应里有 `10040` 思考容器和一个
> `10091` 计时块，但容器的子块只有 `summary: "正在思考"`，`text_block.text` 只出现在
> 正式答案里。也就是说连官方客户端都拿不到推理正文，插件无从转发。README 中英两版已写明。

### 测试

- 新增：登录路由只接受 `{"action":"login"}`（其它 body 一律 400，且 POST 必须带写标记）；
  `src/doubao-auth.ts` 的客户端解密路径不得回归、只保留浏览器密封文件、`findDoubaoUserDataDir`
  仍对外可用。
- 新增：思考开关的上线形态 —— `deepThink: true` → `3`、`false` → `0`、
  「工作任务」未设置 → `10001`，以及「豆包 快速」不可推理。四条都钉在
  `tests/thinking.test.ts` 里，防止以后有人「顺手统一」成同一个值。
- 同步：删除 `store.test.ts` 的 `authMode` 断言、`save-route.test.ts` 的 profile 路由与
  `profileDir` 写入用例；`scripts/check-locale-literals.mjs` 改为「整张表逐条往返解码无损 +
  双语齐备」，因为原来被钉死的那两条 Windows 路径文案随本节一起删除了。

---

## 0.4.1 — 2026-11-05

> 「工作任务」模型接入批次：把豆包客户端里那三个**只能在工作任务模式跑**的条目
> （2.1 Lite `seed-lite-7b`、2.1 Pro `5`、自动 `9`）真正接到 DSH 里，走的正是会员/
> 活动付费额度。上一版把它们整个藏起来，理由是「外部客户端注册不进 CUA 运行时」——
> 那个理由对了一半：运行时确实接不进去，但它不是必需的，`tool_local` 的三条 HTTP
> 接口就够把一轮任务回合走完。新增 4 例回归测试（另改写 2 例旧的「必须隐藏」断言），
> 全仓 189 例。

### 新增

- **豆包 2.1 Lite / 2.1 Pro / 自动 进入模型选择器** —— 选中任一条，请求自动切到
  「工作任务」模式（`mode_id: "3"`、`agent_mode: 1`、`need_deep_think: 10001`、
  新会话 `conversation_mode: 2`、`model_extra_params.input_token_limit: "256k"`，
  `seed-lite-7b` 另带 `reasoning_effort`），`general_task_param` 带 `task_input_json`。
  实机跑通：Lite 与 Pro 各一次纯文本回合，约 5.8 s，`server_model_tag` 为 `38`。
- **`tool_local` 应答器** —— 任务模式下服务端会按 `${unique_key}:${device_id}:${aid}:message:${seq}`
  的顺序下发本地工作区指令；插件并发轮询 `msg/ack`，遇到 `command: 6003`（`cmd_call`，
  如 `local.workspace.apply`）就回 `upload_command_result` + `msg/complete`，遇到
  `command: 6004`（`agent_finished`）收尾。**这是解开 `710010702` 的全部原因。**
- **`CHUNK_DELTA` 增量帧** —— 任务模式的正文增量以无 `block_type` 包裹的
  `{ text, id }` 形式下发，按 `id` 分流到 `reasoning_content` / 正文。

### 修复

- **选 `seed-lite-7b` / `5` 会被静默换成「豆包 快速」** —— `findDoubaoModel` 只在内置
  清单里查，查不到就回落到 `'0'`。现在三条任务模型都在清单里，不再回落。
- **`msg/ack` 批量查询必失败** —— `{ msg_ids: [0..6] }` 会整体报
  `{"code":710010702}`，因为批里只要含一个服务端还没生成的 `seq`，整批就废。
  现在严格单条轮询，逐 `seq` 递进。
- **自动发现把工作任务模型全部隐藏** —— 上一版按名称前缀一律排除。现在改为只排除
  `DOUBAO_UNAVAILABLE_MODELS`（仅剩「即将下线」的 `4`），并按内置清单补齐，避免本机
  IndexedDB 只缓存了对话子集时任务模型消失。

### 已知边界

- 纯文本、不触发本地工具的小回合，服务端会在 `ext` 里标 `general_agent_task_mode: "simple"`
  与 `mode_downgrade_reason: "success"`，此时**不扣**活动赠送额度（实测调用前后
  `usedAmount` 恒为 782）。要消耗付费额度，得让它真的执行多步工具/文档任务。
- `msg/ack` 的 `seq` 没有可查询的上界，应答器在流结束后最多再补 8 次轮询即退出。

---

## 0.4.0 — 2026-11-05

> 稳定性与额度准确性批次：让「回答」在中断时说实话，让「停止」真的停下上游，让凭据不再经过
> 子进程环境变量，让设置卡片不再对任何本机页面敞开；额度读数改成看「还剩多少」，并把一直在
> 扣的活动赠送额度显示出来；卡片重做了一遍视觉。全部改动都带回归测试（新增 36 例，全仓
> 187 例）。

### 修复

- **断流被当成完整回答** —— 豆包服务端提前断开连接时，插件只把缓冲区里已收到的那半截
  文本当结果返回，并照样写 `finish_reason: "stop"` 和 `[DONE]`。用户看到的是一个语法
  通顺、语义中断的回答，没有任何迹象表明它被截断了。现在以 `SSE_REPLY_END` 作为唯一
  的完成依据：连接先断而该帧未到，就报「回答不完整（已收到 N 字符）」而不是假装成功。
  特意**不可重试** —— 重试会新开一条线程，把这条线程上的上下文丢掉，比重打一次更糟。
- **停止按钮停不下上游** —— 客户端断开后没有任何东西通知豆包那边停止生成，那一轮会一直
  跑到结束，额度照扣，答案没人看。现在响应关闭即 `abort()`，并顺着 `fetch` 传到 socket。
  顺带补上空闲看门狗：`DOUBAO_STREAM_IDLE_TIMEOUT_MS`（300 秒）此前定义了却从没被使用，
  流静默这么久会主动中止，而不是把请求永远挂着。
- **所有认不出的失败都被说成网络问题** —— 分类器对未知错误一律 `network`，shim 又把它
  标成可重试的 `TIMEOUT`，于是 400、鉴权失败、插件内部异常都会触发宿主的整套重试，
  最后给出一句「检查网络」。现在按 HTTP 状态与失败来源分类（401/403 → 会话失效、
  429 → 额度耗尽、4xx → 上游错误不可重试、5xx 与连接失败 → 可重试、其余 → 上游错误），
  只有真正的传输失败才会被建议重试，错误信封里也带上 `x-should-retry`。
- **深度思考内容永远为空** —— 帧处理层把 `onThinking` 回调漏掉了（shim 侧的
  `reasoning_content` 分支早就写好了），开启深度思考时只能看到答案、看不到推理过程。
- **凭据明文进了子进程环境变量** —— DPAPI 调用把整个会话以 base64 塞进
  `DSH_DOUBAO_DPAPI_BLOB` 交给 PowerShell，存活了 `Add-Type` 编译那 0.5–1 秒；
  `...process.env` 还把本机所有 API key 一起带了过去。现在改为 stdin 传入、环境变量走
  白名单，`powershell.exe` 也从 `System32` 绝对路径启动而不是靠 PATH 查找。
- **一个坏 profile 会让后面所有候选都不再尝试** —— 候选遍历里 `decryptFromProfile` 没有
  自己的 try/catch，某个目录的 `Local State` 损坏会直接冒到外层，把 D 盘上真正可用的
  profile 全跳过。现在逐个隔离，失败信息里带上具体目录。

- **一次会话失效要等十二小时才自愈** —— 加密的凭据副本在磁盘上缓存 12 小时，服务端
  已经判定失效的 session 会被反复读回来，每次请求都以同一种方式失败；用户按提示重新
  登录，插件仍然拿旧副本，直到 TTL 到期。现在服务端说会话失效就删掉盘上副本，让重新
  登录立刻生效。顺带挡住时钟回拨：缓存时间在未来（改过系统时间、双系统、主板电池没电）
  一律视为过期，否则 TTL 永远算不出一个正数。
- **额度接口不可用时每一轮对话都要多等一次失败** —— 额度是对话前的前置检查，而失败的
  结果从来不进缓存，于是接口挂掉的每一轮都要再付一次注定失败的往返，正好压在首字节
  之前。失败结果现在缓存 30 秒：够短，恢复延迟只有一轮；够长，能把这种反复打穿。
- **设置卡片对本机任何网页敞开** —— 四条路由只校验 Origin 是不是 loopback，而浏览器
  在**同源**请求里根本不发 Origin 头，于是「没有 Origin」被当成可信 —— 本机另一个端口
  上的页面（或任何能解析到 127.0.0.1 的页面）都能改掉模型开关和数据目录。现在 Host
  必须是 loopback（挡住把域名解析到 127.0.0.1 的 DNS rebinding），带
  `sec-fetch-site: cross-site` 的请求直接拒绝，写请求还必须带一个自定义头 —— 自定义头
  会触发 CORS 预检，而这几条路由从不应答预检，跨源页面因此发不出这个请求。同源正常
  使用完全不受影响。
- **声明了类型声明文件，但那文件从来不存在** —— `package.json` 的 `types` 指向
  `lib/index.d.ts`，构建却关着 `dts`，任何按类型使用这个包的人都会碰到一个空引用。
  现在真的生成声明文件（`lib/index.d.ts` 等 5 个），`types` 与 `exports` 两条路径
  都对得上。同时把 `lib/` 移出版本管理：tsdown 用内容哈希给共享 chunk 命名，每构建
  一次整批文件就改名，diff 里看不出任何真实改动；发布不受影响（`prepack` 会构建，
  `files` 从 tarball 里取 `lib`）。

- **额度卡片的「重置时间」是编出来的** —— 这台账号的套餐只返回一个周额度，且窗口的
  `start_time`/`end_time` 都是 0（服务端不给时间戳）。旧代码于是拿「现在」当窗口起点、
  加上一个名义周期当重置时刻，卡片显示「6 天后重置」—— 真实重置可能就在二十分钟后。
  同一份载荷里还带着 `total_amount: "2,100"` / `used_amount: "0"` 这种带千分位的金额，
  旧代码完全没读，一旦 `used_percent` 缺失就只能显示 0%。现在：窗口还没开始计时就照实
  说「开始使用后计时」（豆包客户端本身就是这个措辞），有时间戳就显示倒计时，两者都没
  有才说「重置时间未知」；金额解析后作为百分比的兜底来源。顺带修掉 `doctor` 把「这个
  套餐没有 5 小时窗口」判成失败的误报 —— 账号形态不是插件故障，只有额度真正读不出来
  才算失败。
- **真正在消耗的那份额度没被显示** —— 额度接口返回三个 section，旧代码只读
  `window_limit_section`。这台账号的「活动赠送额度」（`incentive_quota_section`，
  已用 782 / 1,600、11 月 21 日 09:46 到期）因此完全不出现在卡片上：用户看到「近 7 天
  已用 0%」，以为额度一点没动，实际上已经在扣赠送额度了。现在两个 section 一起读，
  赠送额度单独一行、用「已用 782 / 1,600 · 16d 后到期」这种带金额的写法，排在常规窗口
  前面。

### 新增
- **卡片改成看「还剩多少」，并自己走动** —— 进度条过去画的是消耗比例（越用越满），
  与「还剩多少」的直觉相反；现在画剩余量，用完即为空，颜色阈值也按剩余量给。数字从
  「已用 782 / 1,600」改成「剩 818 / 1,600」，倒计时由本地时钟每秒从绝对时刻重算 ——
  既不用每秒请求，也不会因为标签页放久了而漂移。轮询从 5 分钟缩到 30 秒，且只在卡片
  可见时进行，切回标签页立刻刷一次；轮询走 POST 绕过宿主 5 分钟缓存，否则每 30 秒
  拿回的都是同一份读数。
- **卡片重做了一遍视觉** —— 原来五个分区的高度、字号、边框几乎一样，眼睛找不到落点。
  现在整张卡是一片带极淡高光的表面，分区之间用一条发丝线分隔而不是各自套框；每个额度
  窗口是一块独立的面板，一行的重点只有一个：右边那个「还剩下多少」。倒计时和「已用
  X / Y」退到第二行，不再和主数字抢宽度。进度条改成带方向感的渐变并带一点辉光，数字
  改用等宽字形 —— 每秒跳动的倒计时不会再让整行左右抖。

### 测试
- `tests/upstream-terminal.test.ts`（12 例）：终止帧、跨 chunk 拆帧、截断判定、思考透传、
  失败分类与重试矩阵。
- `tests/shim-lifecycle.test.ts`（5 例）：客户端断开、正常结束后关闭、空闲超时、活动续命、
  释放后不再触发。
- `tests/auth-dpapi.test.ts`（4 例）：源码级守住「明文不进 env」「不走 PATH」两条约束。
- `tests/save-route.test.ts`（+4 例）：缺写入头、非 loopback Host、跨站标记三种拒绝路径，
  以及「同源 GET 不带 Origin 仍然放行」这条必须保持可用的例外。
- `tests/quota.test.ts`（8 例）：用真实载荷做固定数据 —— 只有周额度、时间戳为 0、
  另含「活动赠送额度」组（782 / 1,600、只有到期时间、window_type 3）；覆盖「不伪造
  重置时刻」「未开始计时标注 startsOnUse」「赠送额度只报到期」「金额推算百分比」
  「真实时间戳原样透传」五条契约。

## 0.3.1 — 2026-11-02

> 相对 `0.3.0` 的 3 个提交。修「User Data 不在 C 盘就读不到登录信息」，并补上手动指定目录的
> 入口 —— 之前只能靠环境变量。

### 新增

- **手动指定豆包数据目录** —— 设置卡片新增「豆包数据目录」一段，带「选择目录…」按钮
  （桌面端弹系统原生文件夹对话框）和「改回自动探测」。装豆包时把数据目录改到 D 盘、
  或事后手动搬走的人，现在可以自己指路，不用再设环境变量 `DSH_DOUBAO_PROFILE`。
  段落里会显示当前用的是哪个目录，以及探测到的全部候选（带来源：
  `manual` / `env` / `appdata` / `process` / `scan`）。
  - 选中的路径在写入前会校验目录里是否有 `Default\Network\Cookies`，选错当场提示并**拒绝保存**；
  - 选中的目录后来被删掉或搬走，会自动退回自动探测，不会把凭据加载卡死；
  - 指到 `User Data` 本身或它的父目录（例如 `D:\Doubao`）都可以，后者会自动往下找一层。
  - 浏览器形态的宿主没有原生目录对话框，按钮会明确报错而不是静默失败。

### 修复

- **User Data 不在 C 盘就读不到登录信息** —— 凭据查找曾硬编码
  `%LOCALAPPDATA%\Doubao\User Data`，把数据放到 D 盘（安装器提供这个选项，也有人事后手动搬）
  的机器会报 `Doubao user profile not found`，而报错里显示的路径恰恰是用户根本没有的那个。
  现在改为五层回退：卡片里手动选的目录 → 环境变量 `DSH_DOUBAO_PROFILE` → AppData 候选 →
  运行中客户端的 `--user-data-dir` → 限时扫盘（深度 4、1.5 秒预算、跳过系统目录）。
  顺序按**代价**而非准确度排：常见情况 4 次 `existsSync` 就命中，不会为 0.8 秒的进程探测
  拖慢每次冷启动。返回候选**列表**而非单一路径，因为「复制而非移动」会留下空壳 profile —
  凭据加载逐个尝试，取第一个真正解出可用会话的。
- **手动指定的目录失效后会永久留空** —— 覆盖值现在每次都会重新校验，失效的选点自动落回
  自动探测，不再遮蔽真正可用的 profile。
- **提示文案里的 Windows 路径少了一层反斜杠** —— `Default\Network\Cookies` 写在单引号字符串里
  会被当成转义序列，浏览器实际看到的是 `DefaultNetworkCookies`，正好是最需要准确的那句话。
  已补转义，并加了 `scripts/check-locale-literals.mjs` 直接检查构建产物里的字面量
  （`npm run check` 会自动跑）。

### 测试

- 11 个测试文件、**151 个用例**全绿（0.3.0 是 132 例）。新增覆盖：`profileDir` 的存取与非法
  类型、`/__save` 对目录存在性的校验（选错目录必须 400 且不写盘）、`/profile` 只读路由
  （空结果返回 `null` 而不是空字符串）、手动覆盖的优先级与失效回退。
- `doctor` 五项全绿；`doctor --json` 的 `credentials.data.profile` 会显示来源，
  现在多一个 `via manual`。

---

## 0.3.0 — 2026-11-02

> 相对 `0.2.0` 的 15 个提交。这一版把插件从「只能纯聊天」推到了「能生图、能续聊、
> 能让模型通过提示词层模拟去调工具」，并修掉了一个从项目第一天就存在的设置持久化缺陷。

### 新增

- **豆包生图（Seedream 5.0）** —— 模型选择器里新增「豆包 生图（Seedream 5.0）」。
  生成结果以 Markdown 图片形式追加在回复正文里，可直接预览与保存。
  实测一次请求返回 3 张 2848×1600 图片（右下角带「豆包 AI生成」水印）。
  注意 URL 后缀是 `.jpeg` 但字节是 PNG，保存时按内容判格式。
- **模型清单自动发现** —— 不再硬编码模型名。插件直接读豆包客户端的本地缓存
  （`menuConfV2`，V8 structured clone 编码），豆包上线新模型时清单会自动跟上。
  缓存解析失败时自动回退到内置静态清单，`doctor` 会显示当前用的是哪一种。
  「工作任务」专属模型按名称前缀自动隐藏。
- **真会话续聊** —— 同一个 DSH 会话的第二轮起只发送增量消息，由豆包服务端维护线程内存，
  不再每轮重发全部历史。实测第二轮只发 20 个字符，服务端仍能答出上一轮的内容。
- **深度思考分离** —— 开启深度思考后，思考过程走 `reasoning_content` 而不是混进正文。
- **实验性工具调用（提示词层模拟）** —— 让豆包能驱动 DSH 的本地工具（读写文件等）。
  默认**关闭**，设置卡片里有独立开关。实现方式是在提示词里注入工具契约，再把模型输出的
  ` ```doubao-tool ` 围栏解析回标准 `tool_calls`。实测 5 次调用、坏 JSON 0 次、5/5 轮收敛。
- **设置卡片新增工具开关段落** —— 与模型清单分开保存，避免「换模型」和「放开文件权限」
  共用一次确认；关不掉的权限开关是比误开更坏的失败。
- **手动指定豆包数据目录** —— 设置卡片新增「豆包数据目录」一段，带「选择目录…」按钮
  （桌面端弹原生文件夹对话框）和「改回自动探测」。装豆包时把数据目录改到 D 盘、或者事后
  手动搬走的人，现在可以自己指路，不用再设环境变量。选中的路径在写入前会校验
  `Default\Network\Cookies` 是否存在，选错当场提示且不落盘；已选的目录后来被删掉会自动
  退回自动探测。段落里会列出当前用着哪个目录、以及探测到的全部候选。

### 修复

- **设置保存失败（从项目第一天就存在）** —— 症状是点开关报
  `保存失败：host did not persist the value`，或看起来保存成功但刷新后回退。
  根因不在 schema：本插件的 fiber 在 DSH 0.2.1 上**永远停在 `state 1`（LOADING）**，
  宿主因此从不给它挂 `runtime.Config`，`describe()` 直接过滤掉命名空间，任何写入都失败于
  `No configurable plugin entry "dsh-connect-doubao"`。
  **这意味着历史上这个插件的设置一次都没能落盘过，包括手工改 `cordis.patch.yml` 的那些。**
  现在两个开关改存插件自己的 `~/.dsh/dsh-connect-doubao.settings.json`，
  写入是先写临时文件再原子重命名，读取不依赖任何宿主服务在线。
- **工具契约导致幻觉** —— 温和措辞的契约下，模型会回「已完成修改：…」但**磁盘根本没动**。
  这是最坏的失败模式：用户以为文件改了。契约已改为硬性规则（第一条回复必须是工具调用、
  严禁在没有 `[tool result]` 时声称完成），实测从 0/2 提升到 2/2。
- **多步编辑互相污染** —— 局部替换链会让第 N 次编辑失效于第 N+1 次，最终文件出现重复行。
  契约加入「每次修改后重新读取文件再决定下一步」后，同一任务 1 次 edit + 1 次 read 收敛。
- **回复首字丢失** —— 回复开头在 `STREAM_MSG_NOTIFY`、增量在 `STREAM_CHUNK`，
  旧代码只取一边导致「1+1」变成「+1」。已抽出 `assembleReplyText` 统一拼接。
- **对话模式根本不通** —— `agent_mode` 常量写反（1/2 互相搞错），每一轮都被路由到
  豆包的任务 agent，直接回 `710010702`。已按 CDP 抓到的真实请求体整体重写。
- **User Data 不在 C 盘就读不到登录信息** —— 凭据查找曾硬编码
  `%LOCALAPPDATA%\Doubao\User Data`，把数据放到 D 盘（安装器提供这个选项，也有人事后手动搬）
  的机器会报 `Doubao user profile not found`。现在改为五层回退：设置卡片里手动选的目录 →
  环境变量 `DSH_DOUBAO_PROFILE` → AppData 候选 → 运行中客户端的 `--user-data-dir` → 限时扫盘。
  顺序按**代价**而非准确度排：常见情况 4 次 `existsSync` 就命中，不会为 0.8 s 的进程探测
  拖慢每次冷启动。返回的是候选**列表**而非单一路径，因为「复制而非移动」会留下空壳 profile —
  凭据加载会逐个尝试，取第一个真正能解出可用会话的。

### 改进

- **改动说明改为逐条列出** —— 工具执行完成后不再只说「已修改」，而是按「哪个文件 → 改了什么 →
  为什么」逐条说明，多处改动分别列出。
- **请求体形状有测试钉住** —— 18 个断言全部取自 CDP 抓包而非由被测常量反推，
  防止 `agent_mode` 这类常量再次静默回归。

### 已知限制

- **选不到 2.1 Pro / 2.1 Lite**。服务端**不校验** `model_item_key`（四种真 key 和一个不存在的
  key 耗时与长度无可测差异），模型由服务端按产品/模式/账号决定。目录已收缩为
  「快速 / 2.1 Turbo·专家 / 生图」三项，Pro/Lite 只能在豆包客户端自己的「工作任务」里用。
- **「工作任务 · 本地电脑」调不到**。协议层字段（`runtime_type: 2`、`sandbox_id`、`device_name`）
  都能发对，但执行者是需要 App 进程内 CUA 运行时的组件，外部客户端一律
  `710010702`。插件默认走纯对话模式，`DSH_DOUBAO_TASK=1` 才尝试任务模式。
- **工具模拟只在豆包自身不具备的能力上可靠**。让它「查天气」时它会改用自带联网搜索，
  不调用我们的工具。
- **Windows only**。凭据解密依赖 DPAPI。User Data 可以不在 C 盘（见上文五层回退）。
  浏览器形态的宿主没有原生目录对话框，「选择目录…」会明确报错而不是静默失败，
  那种环境请用 `DSH_DOUBAO_PROFILE`。

### 测试

- 11 个测试文件、**151 个用例**全绿。本版新增三个文件：`store.test.ts` 20 例（文件合并语义、
  原子写入、无临时文件残留、`profileDir` 存取与非法类型）、`save-route.test.ts` 20 例
  （字段白名单、Origin 校验、值形状、500 契约、`profileDir` 的路径存在性校验、`/profile`
  只读路由）、`profile.test.ts` 25 例（五层探测优先级、去重、扫描深度与时间预算、
  手动覆盖的优先与失效回退）。
- `doctor` 五项全绿：凭据 29 cookie / 账号通过 / shim OK / 额度 / 模型发现。
  `doctor --json` 的 `credentials.data` 现在同时给出 `profile`（用的是哪个、`via env|appdata|
  process|scan|manual`）与 `candidates`（全部候选），定位"读不到登录信息"时先看这两项。

---

## 0.2.0

- 修复对话模式完全不通（`agent_mode` 常量写反）。
- 请求体按 CDP 抓包重写。

## 0.1.1 / 0.1.0

- 首个可用版本：凭据复用（DPAPI + AES-GCM）、provider 注册、只读额度卡片。
