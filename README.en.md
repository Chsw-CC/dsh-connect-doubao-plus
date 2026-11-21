# DSH Connect Doubao Plus

> Connect a Doubao account to DeepSeek Harness: the model list is copied from Doubao's
> own menu, one QR sign-in, and chain-of-thought plus per-model effort ladders, Seedream
> image generation, native DSH token stats and a read-only quota panel all live inside
> Harness. The session is sealed on this machine only (DPAPI on Windows, AES-256-GCM
> elsewhere); Harness-to-plugin traffic stays on `127.0.0.1`, while the plugin
> itself talks to Doubao over HTTPS with your session.

[![release](https://img.shields.io/github/v/release/Chsw-CC/dsh-connect-doubao-plus)](https://github.com/Chsw-CC/dsh-connect-doubao-plus/releases)
[![version](https://img.shields.io/badge/version-0.15.0-blue)](./CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#platform-support)
[![dshfind](https://img.shields.io/badge/dshmarket-dshfind-blueviolet)](https://dshfind.dev)

![Doubao card: quota panel and model checklist](docs/assets/dsh-connect-doubao-quota-card.png)

> 🍴 This repository is a **fork** of
> [Wahwayhale/dsh-connect-doubao](https://github.com/Wahwayhale/dsh-connect-doubao),
> originally created by **[@Wahwayhale](https://github.com/Wahwayhale)** ([MIT](./LICENSE));
> maintainers and every contributor source are listed under [Acknowledgements](#acknowledgements).

---

## Why install it

| Where you are today | What changes |
| --- | --- |
| Doubao works in the browser, but DSH cannot see it | The plugin registers a provider; a 「豆包（Doubao）」 group appears in the model picker |
| Models, multipliers and effort ladders move with the client, so plugins lag | The client's own menu cache is read, so additions and price changes show up on the next refresh — no plugin release needed |
| Membership quota is only visible on the website | The card leads with an **available credits** total (package balance + activity grant), then breaks out the monthly and grant windows with their own reset countdowns; nothing on the account is modified |
| Chain-of-thought is swallowed by middle layers | `reasoning_content` is passed through verbatim, with native DSH TTFT, throughput and cache-hit stats |
| Image generation means another tab and a manual save | Pick 「豆包 生图」 in the picker and the reply carries a downloadable image, streamed to disk |

## What it does

- **Automatic model discovery** — reads the menu cache under `Default/Preferences` and routes by `model_item_key`; chat models and 「工作任务」 (task-mode, paid membership quota) models are labelled separately, and picking a task model switches the full request shape.
- **Reasoning passthrough and effort ladders** — thinking content is streamed verbatim; the ladder comes from the per-model `reasoning_effort_config`, measured values 3 / 4 / 5, higher levels declared only in the menu. Deep thinking is on by default; `DSH_DOUBAO_DEEP_THINK=0` turns it off.
- **Seedream image generation** — end to end; images stream to disk with a 24 MB per-image and 8-per-turn ceiling; over-limit images keep their remote URL instead of being written locally.
- **Quota panel and daily check-in** — an available-credits total on top, then monthly and grant windows with separate countdowns; one-click 「天天领额度」 (+200/day), plus an optional automatic check-in (off by default, Beijing-time day boundary).
- **Tool emulation (on by default)** — OpenAI `tools` → `doubao-tool` fence → `tool_calls`, so Doubao can drive DSH's local tools. Parsing only accepts tools the request actually declared; workspace permissions and execution stay on the Harness side. Disable with `toolEmulation: false`.
- **Local-only loop** — chat goes through a shim bound to `127.0.0.1` with a per-process shared secret; any non-local request gets 401. Credentials are sealed with DPAPI / AES-256-GCM and cached in-process for 10 minutes.
- **Command-line checks** — `doctor` verifies credentials, account, shim, quota and models without spending quota; `probe` runs one real chat as a smoke test.

### Measured on 0.12.4 (this machine, not a cross-environment promise)

| Metric | Before → after |
| --- | --- |
| 4 generated images written (150 ms each) | 608 ms → **165 ms** |
| One 12 MB image written | whole-buffer → **28 ms, streamed** |
| 5,000 SSE chunks written (loopback) | 36–54 ms → **2.6–3.3 ms** |
| One 200 KB SSE frame parsed | 20.2 ms → **0.3 ms** |
| Token estimate over 1.2 MB text | 15.0 ms → **2.1 ms** |
| Cold quota read blocking a turn | 10 s → **1.5 s cap** |
| Quota card upstream requests | ~120 → **~40 per hour** |

## Quick start (30 seconds)

1. **Install** — use the release tarball, or link the source directory (details under [Installation](#installation)).
2. **Sign in** — Settings → Doubao → 「重新登录」, then scan the code in the Chromium window; the session is sealed locally right away.
3. **Pick models** — tick the entries you want in the model picker and save.

```bash
# install from the tarball (recommended)
dsh plugin --profile desktop add "<path>/dsh-connect-doubao-plus-0.15.0.tgz"
```

> This plugin is not on the npm registry and does not support `dsh plugin add <git url>`: `prepack` needs `npm`, while the runtime shipped with Harness only has `node`. Both the tarball and the source directory load the already-built `lib/` — no build step.

## Compatibility & prerequisites

| Item | Requirement |
| --- | --- |
| DeepSeek Harness | `>=0.1.7-rc.1 <0.3.0-0` (measured `0.2.0-rc.2`) |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| `@earendil-works/pi-ai` | `>=0.85.0 <0.88.0` (host measured `0.87.1`) |
| Operating system | Windows / macOS / Linux — differences under [Platform support](#platform-support) |
| Browser | A local Chromium-based browser (Chrome / Edge / Chromium); `DSH_DOUBAO_CHROME` can point at any binary |
| Account | One QR sign-in; free accounts connect but have a small quota |

With no session the plugin fails loudly ("还没有浏览器登录态…") instead of silently.

## How far verification goes

| Environment | Verified up to |
| --- | --- |
| Windows x64 · Doubao 2.31.4 · DSH 0.2.0-rc.2 | sign-in, auth, quota, model discovery, a real chat, card rendering (screenshots) |
| macOS arm64 | sign-in, auth, activity-grant read, one real `/chat/completion`, `cli-probe --json` all green |
| Linux | same AES-256-GCM path; builds and tests pass, sign-in chain not exercised on real hardware |

Code-level evidence: `doctor` passes all five checks — 29 cookies read, 9/9 required session cookies present, a wrong bearer returns 401, three quota windows readable, 6 models discovered.

![Doubao entries in the model picker](docs/assets/dsh-connect-doubao-settings-section.png)

**What this does not mean** — it holds for that machine and that account at that moment, and is not a compatibility guarantee. Boundaries are under [Known limitations](#known-limitations-please-set-expectations-honestly).

## Documentation map

| You want | Go to |
| --- | --- |
| Where the model list comes from | [Model catalog](#model-catalog) |
| Architecture and request shapes | [How it works](#how-it-works) |
| Install or sign-in trouble | [Installation](#installation), [Command line](#command-line) |
| Known boundaries | [Known limitations](#known-limitations-please-set-expectations-honestly) |

---

## Model catalog

The catalog is read from the Doubao client's own configuration cache (`menuConfV2`,
the document the server hands the app) — not reconstructed by guesswork. The
`model_item_key` **is** the DSH model id, on purpose: one string instead of a
translation layer that could only be wrong.

| id | name | badge | mode | reasoning |
| --- | --- | --- | --- | --- |
| `0` | 豆包 快速 | — | 对话 | ✅ |
| `3` | 豆包 2.1 Turbo | `专家` | 对话 | ✅ |
| `seed-lite-7b` | 豆包 2.1 Lite | `工作任务` | 工作任务 | ✅ |
| `5` | 豆包 2.1 Pro | `工作任务` | 工作任务 | ✅ |
| `9` | 自动 | `工作任务` | 工作任务 | ✅ |

The three `工作任务` rows switch the request into task mode (`mode_id: "3"`,
`agent_mode: 1`, `need_deep_think: 10001`) and are answered by the plugin's own
`tool_local` responder — see 「工作任务」 mode below. They are the entries that spend
the **paid membership quota**.

**Reasoning effort**: low = `3`, mid = `4`, high = `5`. These values were read by
**diffing the configuration the client re-serialises when the level is switched**,
then independently confirmed against `reasoning_effort_config` in the client's own
config. They are observed, not inferred.

**The deep-thinking switch is ON by default** (since 2026-11-07): non-task models send
`need_deep_think: 3` together with `ext.use_deep_think: "3"`, while the task models
(2.1 Lite / Pro / Auto) keep the `10001` shape captured from the official client.
`DSH_DOUBAO_DEEP_THINK=0` restores the ordinary non-thinking turn. The effort level
still travels only as `reasoning_effort`; the switch is a separate axis.

「豆包 快速」 **does not think**: with the switch fully on and effort at high its reply is
still `thinking: false` and the stream carries no `10040` container, so it is marked
non-reasoning and the picker no longer offers low/mid/high for it.

> **Why the thinking is not visible**: with the switch on the server really does think —
> the response carries a `10040` thinking container and a `10091` elapsed block — but the
> **reasoning text is never sent**. Confirmed 2026-11-07 by capturing the official client:
> the container's child block holds only `summary: "正在思考"`, and the answer blocks hold
> only the answer. This is an endpoint limitation, not text this plugin drops.

> 「即将下线」 is not a property of the Turbo model: the app publishes **two** Turbo
> entries and only the retiring one carries that badge. The retiring one (`4`) is
> the only entry withheld from the picker.

---

## How it works

```
DSH (pi-ai provider)
  └─ doubao-adapter ──► local loopback shim (127.0.0.1, per-process secret)
                         └─ doubao-upstream ──► Doubao /chat/completion
                                                 (with the cookie from the sealed session)
```

1. **Credentials** come only from the browser sign-in: one CDP `Storage.getCookies`
   call, sealed immediately into `~/.dsh/doubao-credentials-browser.dpapi` (Windows
   DPAPI; AES-256-GCM on other platforms). The values reach the outbound request
   header and nothing else — never logs, argv, the environment or another file.
2. **Provider** translates pi-ai's OpenAI-shaped request into Doubao's dialect
   (`bot_id` + `reasoning_effort`).
3. **Streaming** — upstream's three-line frames are parsed into pi-ai's event stream;
   tool calls, compaction and permissions stay Harness-owned.
4. **Task mode** — for the `工作任务` entries, `doubao-upstream` additionally runs a
   `tool_local` responder: it polls the server's `msg/ack` **one `msg_id` at a time**
   (a batch containing a not-yet-generated seq fails the whole batch with
   `710010702`), answers `cmd_call` via `upload_command_result` + `msg/complete`, and
   stops on `agent_finished`. Incremental `CHUNK_DELTA` frames are split into
   thinking/answer by their block id.
   A `cmd_call` then takes one of two paths: the runtime's **own bookkeeping**
   (`init_agent_workspace`, `append_workspace_trajectory_memory`, `write_workspace_*`)
   is performed locally, but only for paths under the runtime's `.sessions/` prefix —
   judged by which paths it writes, not by a name list, so a new command name cannot
   slip through. **Real workspace operations** are mapped onto DSH tools the current
   request declared (`write_file` / `append_file` / Bash) and executed by the host,
   with `finish_reason` becoming `tool_calls`; paths containing `..`, absolute paths
   and unmappable operations fail explicitly instead of being reported as done. In a
   PTC session (only `run_code` declared) file operations are compiled into a program.
   A failed mapping writes one diagnostic line to `~/.dsh/doubao-task.log` — failures only.
5. **Read-only routes** — `/plugins/dsh-connect-doubao-plus/quota` and `/catalog` serve quota
   and catalog from an **explicit allow-list** (no upstream field is passed through),
   and refuse non-loopback origins.

---

## Installation

```bash
# ① install the packaged tarball from the GitHub release (recommended)
dsh plugin --profile desktop add "path\dsh-connect-doubao-plus-0.9.0.tgz"

# ② local development (links the source directory)
git clone https://github.com/Chsw-CC/dsh-connect-doubao-plus.git
cd dsh-connect-doubao-plus && npm i && npm run build
dsh plugin --profile desktop add "path\dsh-connect-doubao-plus"
```

> Option ② writes a `link:` dependency — after editing the sources, just run
> `npm run build`; no reinstall is needed.

> ⚠️ **This plugin is not published to the npm registry**, and adding it by git URL
> does not work yet: the repo's `prepack` runs `npm run build`, while the runtime
> shipped with Harness only provides `node`, not `npm`, so pnpm's git install fails
> during the prepare step. Use the tarball or the local directory instead — both load
> the already-built `lib/` output and need no build step.

### Supported host range

| Component | Version |
| --- | --- |
| DeepSeek Harness | `>=0.1.7-rc.1 <0.3.0-0` (verified on `0.2.0-rc.2`) |
| `@earendil-works/pi-ai` | `>=0.85.0 <0.88.0` (host runs `0.87.1`) |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

All official `@deepseek-ai/*` dependencies are declared as **`peerDependencies`**
(never bundled, always the host's copy) — which is both a hard requirement of the
plugin marketplace and what keeps runtime types consistent.

---

## Platform support

| Platform | Status | Session sealing |
| --- | --- | --- |
| **Windows x64** | ✅ **verified on real hardware** | Windows DPAPI (current-user scope) |
| **macOS** | ✅ verified (QR sign-in + chat + activity grant + menu-driven model discovery, end to end) | AES-256-GCM + local 0600 key |
| **Linux** | ✅ supported (same AES-256-GCM path; not exercised on hardware) | AES-256-GCM + local 0600 key |

**Session** — one source only (`src/doubao-auth.ts` + `src/doubao-auth-browser.ts`):

1. the card's 「重新登录」 launches a dedicated Chromium profile
   (`~/.dsh/doubao-browser-profile`) on `https://www.doubao.com/chat/`;
2. you scan the code, and the plugin collects every cookie with one CDP
   `Storage.getCookies` call;
3. only the Doubao/Bytedance cookies are kept, and only if all 9 required session
   cookies are there; the result is sealed into
   `~/.dsh/doubao-credentials-browser.dpapi` — Windows DPAPI (current-user scope) or
   AES-256-GCM under `~/.dsh/doubao-credentials.key` (0600) on macOS / Linux. Either
   way another account or machine cannot open it;
4. every later request reads that file, cached in-process for 10 minutes.

**Why the client's cookie jar is no longer decrypted.** While the Doubao client runs it
holds `Default\Network\Cookies` with an EXCLUSIVE lock — and this plugin exists for
exactly that account. The read failed, the code fell back to a 12-hour-old sealed copy,
the server had long rotated the session, and every request was rejected upstream while
the local state still claimed "signed in", leaving the user nothing to act on. The
browser sign-in has no such corner: the cookies are captured live, and what gets sealed
is what was just captured, so there is no older copy to prefer.

**Data directory (unrelated to the session).** `listDoubaoProfiles`
(`src/doubao-profile.ts`) tries, cheapest first: `profileDir` from the settings file /
`DSH_DOUBAO_PROFILE` → AppData candidates → the running client's `--user-data-dir` →
a time-boxed drive scan. It now feeds only the client-cache model discovery and the
task-mode workspace; when it finds nothing the workspace falls back to a temp directory
and chat still works.

macOS lays this out differently: the data directory is `~/Library/Application Support/Doubao`
(there is no `User Data` level) and the cookie jar is `Default/Cookies` rather than
`Default/Network/Cookies`. Both spellings are recognised. The Linux client layout has not been
read on real hardware, so no probing is attempted there.

`node lib/cli-doctor.js --json` still reports where that directory came from
(`credentials.data.profile`, with its source) and every candidate it saw
(`credentials.data.candidates`).

---

## Command line

```bash
# check the whole chain without spending inference quota
dsh-connect-doubao-plus-doctor
dsh-connect-doubao-plus-doctor --json

# smoke probe (spends one inference request)
dsh-connect-doubao-plus-probe --prompt "hi"
dsh-connect-doubao-plus-probe --prompt "hi" --model 5 --thinking high --json
```

Full `probe` flags:

```
--prompt <text>              the prompt (default "hi")
--model <key>                model id from the table above
--thinking <low|mid|high>    reasoning effort
--json                       emit JSON
--timeout <ms>               timeout (default 120000)
```

`doctor` reports five independent checks: credentials / account / provider assembly /
quota / model discovery. It prints **counts only**, never values.

---

## Development

```bash
npm install
npm run typecheck   # node-side and browser-side tsconfigs
npm run build       # two targets: node (ESM) + browser (CJS)
npm run test        # client bundle format regression
npm run check       # all of the above
```

> ⚠️ The browser bundle **must be CommonJS**: the desktop shell loads it with a
> `<script>` tag and no `type="module"`. An ESM bundle throws
> `Cannot use import statement outside a module` and fails the whole web boot
> (`1 entry did not activate`). `tests/client-bundle-format.test.ts` pins that rule.

---

## Known limitations (please set expectations honestly)

1. **It uses a non-public interface.** Doubao publishes no third-party API; this
   plugin reverses the behaviour of its own client. Any upstream change can break it,
   without notice.
2. **`'4'` (豆包 2.1 Turbo, "即将下线") is unverified** — and withheld from the
   picker. The other 5 entries were exercised in real conversations, including both
   task-mode models.
3. **Task mode works, but whether a turn is billed depends on what it did.** In task
   mode the server hands each turn to `Agent-GeneralTask`, and the plugin runs a
   `tool_local` responder alongside (`msg/ack` → `upload_command_result` →
   `msg/complete`) so the local workspace commands complete instead of failing with
   `710010702`. **For a plain-text turn that triggers no local tool, the server marks
   the round `general_agent_task_mode: "simple"` with `mode_downgrade_reason: "success"`,
   and the activity-grant `usedAmount` does not move** (measured: unchanged at 782
   across a call — i.e. downgraded, not billed). To actually spend the paid quota, the
   turn has to do multi-step tool/document work. This is a measurement, not a promise.
4. **There is no response-side field that proves "the server really used that model".**
   The upstream SSE carries an opaque marker in `message.ext` (observed as `38`); it is
   **not** a version number or a tier, and ByteDance has never published its meaning.
   What this plugin can establish is that it sends `model_item_key` with the request
   (confirmed by packet capture). How the server interprets that key is the server's
   own business — sending an invented key still returns HTTP 200, so the field is not
   validated. What 0.4.1 offers is **the whole task-mode request shape for a given
   key** (verified to answer), not a guarantee that Pro rather than Lite did the work.
5. **No Doubao app install required.** The session comes from the browser sign-in
   and is sealed with DPAPI on Windows / AES-256-GCM elsewhere. `User Data` is only
   read for model discovery and the task-mode workspace (see the lookup above); when it
   is missing the workspace falls back to a temp directory and the session is unaffected.
6. **Risk-control sliders cannot be automated.** When one fires, complete it in the
   sign-in window that just opened, then press 「重新登录」 again.
7. **No image input.** The provider sends text blocks only.
8. **Single account.** No account pool, no region switching, no check-in.

---

## Disclaimer

For **personal study and research only**.

- By using this plugin you agree to comply with the **Doubao terms of service**;
- Use at your own risk; **the author accepts no liability** for account bans, quota
  loss, or any other consequence;
- This project is **not affiliated with or endorsed by ByteDance, DeepSeek, or the
  DeepSeek Harness maintainers**;
- Not for commercial use or any purpose beyond personal study.

---

## Acknowledgements

- **Original author**: this project was created by **[@Wahwayhale](https://github.com/Wahwayhale)**,
  who maintains the upstream repository
  [Wahwayhale/dsh-connect-doubao](https://github.com/Wahwayhale/dsh-connect-doubao)
  under the [MIT](./LICENSE) license. This repository is a fork of it; see the upstream
  [contributors](https://github.com/Wahwayhale/dsh-connect-doubao/graphs/contributors)
  for the full list.
- **Upstream PR contributors** (sources of the changes merged or queued in this fork):
  - [chenyusheng](https://github.com/chenyusheng) — [#12](https://github.com/Wahwayhale/dsh-connect-doubao/pull/12) macOS/Linux browser QR sign-in support
  - [neu-meng](https://github.com/neu-meng) — [#21](https://github.com/Wahwayhale/dsh-connect-doubao/pull/21) macOS client-menu model discovery (data-directory probing no longer Windows-only)
  - [zuosus](https://github.com/zuosus) — [#6](https://github.com/Wahwayhale/dsh-connect-doubao/pull/6) macOS support
  - [Chsw-CC](https://github.com/Chsw-CC) — [#4](https://github.com/Wahwayhale/dsh-connect-doubao/pull/4), [#16](https://github.com/Wahwayhale/dsh-connect-doubao/pull/16) session-continuation robustness fixes (710020202)
- **dsh-connect-workbuddy** — this plugin borrowed its **design ideas and plugin
  structure** (loopback shim, provider registration path, settings-card mounting,
  build and packaging conventions). **All code is an independent implementation**;
  none of its source was copied.

## Third-party dependencies

| Dependency | Purpose |
| --- | --- |
| `@earendil-works/pi-ai` | model provider runtime (host-provided) |
| `@deepseek-ai/*` | Harness plugin framework (host-provided) |
| `@deepseek-ai/schemastery` | settings schema (host-provided) |

No third-party connector plugin is a runtime dependency.

## License

[MIT](./LICENSE)
