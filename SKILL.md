---
name: wechat-mp-draft-publish
slug: wechat-mp-draft-publish
displayName: 微信公众号草稿箱发布
version: 1.0.0
summary: 把图文投进微信公众号草稿箱的实测口径与工具：正文图片重新托管、2.35:1 封面、draft/add 与就地更新、回读校验，无 API 权限时给手工粘贴通道。
license: MIT
homepage: https://github.com/YS-yiqu/wechat-mp-draft-publish
tags: [wechat, 公众号, draft, 草稿箱, publishing, cover, html]
description: Publish an article (title, digest, inline-styled HTML body, 2.35:1 cover) into a WeChat Official Account 草稿箱 via the draft/add API, or fall back to a hand-paste path when the account lacks API permission. Use when the user wants to put content into 公众号草稿箱 / 微信公众号草稿 / WeChat draft box, or needs a WeChat-ready cover image and body HTML.
whenToUse: Use when the task involves publishing or preparing content for a WeChat Official Account (公众号) draft box, including generating the 2.35:1 cover image, the inlined HTML body, or running the draft/add API flow.
metadata:
  short-description: Publish content into a WeChat Official Account draft box
  category: publishing
  tags: [wechat, 公众号, draft, 草稿箱, publishing, cover, html]
---

# WeChat Official Account Draft Publisher

Put a finished article into a 公众号草稿箱. The work is **not** mainly calling an
API — it is satisfying the platform's real constraints and choosing the right
path for the account type.

## Platform constraints that drive every decision

**Each row is marked with how it is known.** Do not treat a "docs only" row as
enforced, and never let one silently reshape an article's content.

| Constraint | Real limit | Source |
|---|---|---|
| `title` | **64 characters** | ✅ measured (65 → errcode 45003) |
| `digest` | **120 characters** | ✅ measured (121 → errcode 45004) |
| `content` chars | **≥100,000** (limit not reached) | ✅ measured |
| `content` bytes | ~300KB accepted; ceiling not reached | ✅ measured |
| `thumb_media_id` | must be a **permanent** material ID | docs (structural, unverified) |
| images inside `content` | URL must come from the 上传图文消息内图片 interface | docs (external URLs are stripped) |

`scripts/probe-limits.mjs` re-derives the measured rows against the live API.
Run it before trusting this table after any WeChat change.

### ⚠️ Do NOT import limits from documentation without measuring them

This skill previously carried three limits taken straight from the official
`draft/add` doc. Measured against the live API, **two of the three were wrong**:

| Field | Doc claimed | Measured |
|---|---|---|
| `content` | "大小不可超过 2kb" (2048 bytes) | 36,939 bytes accepted, intact |
| `title` | ≤32 characters | 64 characters |
| `digest` | ≤120 characters | 120 ✓ |

There is **no 2KB limit**. The cost of believing there was: articles were
compressed, styling was trimmed, and a hard guard *rejected* bodies over 2048
bytes — all for a constraint that does not exist. A title budget half the real
size had the same effect.

**The rule this leaves behind:** the documented *spec* and the runtime
*enforcement* are different things, and only one of them decides whether a
publish succeeds. Any time a limit is about to (a) change what gets written,
(b) reject work, or (c) justify compression, **measure it first**. Say which
figures are measured and which are only quoted — including in the code comments.

## Decide the path first

| Account type | Path |
|---|---|
| 服务号 / 认证订阅号 with draft API permission | **API path** (below) |
| **个人订阅号** (personal) | **Manual path** — has **no** draft API permission |

Do not promise the API path before confirming the account has it. If unsure,
just run the API path: a permission failure returns a clear error code and you
can fall back cleanly.

## API path

### Step 0 — collect credentials and clear the IP whitelist

Need `AppID` and `AppSecret` from 公众平台 → 设置与开发 → 开发 → 基本配置.

**Credentials belong in the Windows user environment variables**, not in chat
and not in a script file:

```powershell
setx WX_APPID "wx..."
setx WX_SECRET "..."
```

`publish.mjs` and `account-status.mjs` resolve each credential in this order:

1. the current process environment;
2. **the `HKCU\Environment` registry value** (read via `reg query`).

The registry fallback is not decoration. Windows does **not** inject a newly set
variable into an already-running process, so a long-lived agent shell keeps
seeing an empty value no matter what the user sets — and the user should not have
to restart anything to be obeyed. The registry is live; read it.

`scripts/load-wechat-env.ps1` does the same for PowerShell callers:

```powershell
. <skill-root>/scripts/load-wechat-env.ps1    # 注入当前进程
node <skill-root>/scripts/publish.mjs ...
```

⚠️ **PowerShell scripts here need a UTF-8 BOM.** Windows PowerShell 5.1 decodes
a `.ps1` without a BOM using the system ANSI codepage (GBK on this machine),
which turns Chinese messages into mojibake and then fails to parse — the error
looks like a syntax error, but encoding is the real cause. After writing any
`.ps1` containing non-ASCII text, convert it:

```powershell
$t = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($true))
```

**The IP whitelist is the single most common failure, and it recurs.** If the
user's public IP changes (mobile hotspot, re-dial, proxy), every call starts
failing with `40164` again. Do not rely on remembering to warn them — the
scripts handle it:

- `publish.mjs` **self-checks the egress IP before calling the API** and prints
  it, plus a carrier-specific warning when the carrier is one whose IPs rotate.
- On a real `40164`, `publish.mjs` extracts the IP **from WeChat's own error
  message** (authoritative — IP-lookup sites can disagree behind a proxy),
  prints the exact whitelist path, and **exits with code 2** so a caller can
  detect "needs whitelist" distinctly from other failures.
- `scripts/test-40164.mjs` unit-tests that branch, which cannot be reproduced
  on a correctly configured account.

**The durable fix is an IP range, not a single IP.** For 公众号/服务号 the
whitelist accepts specific IPs and CIDR ranges (e.g. `223.104.40.0/24`), and
multiple entries. Note the rules differ per business: mini-programs accept
`172.0.0.*` but 公众号 does **not** accept the `*` form — use CIDR. Whitelisting
a `/24` removes the recurring failure for rotating mobile-carrier addresses.
Effective within about 10 minutes.

**Observed in practice:** the egress IP moved from `203.0.113.14`
(China Mobile, `223.104.0.0/13`) to `198.51.100.23` (China Unicom Beijing,
`123.112.0.0/12` per APNIC RDAP handle UNICOM-BJ) between two sessions — a
different carrier entirely, so a `/24` around the first address would not have
survived. When the observed IP has moved across carriers like this, recommend
whitelisting **several /24s** rather than chasing one address at a time, and say
plainly that a single entry will keep breaking. The `CARRIER_RANGES` table in
`publish.mjs` carries these verified allocations; extend it (from RDAP, not from
guessing) when a new carrier shows up as `未知运营商`.

Whitelist path: 微信开发者平台 → 我的业务 → 公众号 → 基础信息 → 开发信息
(not the older 开发-基本配置 entry).

**ALWAYS give the user a clickable link, not just a navigation path.** The user
asked for this explicitly: they cannot act on "go to 我的业务 → ..." without
hunting; a URL takes them there. Two working entry points (both verified to
respond; unauthenticated visits bounce to the login page, which is expected):

- 微信开发者平台 — <https://developers.weixin.qq.com/platform/>
  then 我的业务 → 公众号 → 基础信息 → 开发信息 → IP 白名单
- 公众平台（用户更熟悉） —
  <https://mp.weixin.qq.com/advanced/advanced?action=dev&t=advanced/dev&lang=zh_CN>
  then 开发 → 基本配置 → IP 白名单

Do not try to derive a deep link straight to the whitelist form: its post-login
URL cannot be verified from outside an authenticated session, and a wrong link is
worse than a correct navigation hint. Give the entry point plus the path.

Observed in practice: the IP moved `198.51.100.23` → `198.51.100.20`
(same carrier, same `/16`, different `/24`) within one session, so the `/24` the
user had whitelisted stopped covering it. Recommend a `/16` once a user has been
bitten twice within the same /16 rather than handing them another `/24`.

Also worth knowing: `40164` is triggered by calls using `AppSecret` **or**
`access_token`. And if the secret is wrong **and** the IP is unlisted, WeChat
reports `40125` first — so a bad secret masks an IP problem.

### Step 1 — generate the cover (if not supplied)

WeChat's cover ratio is **2.35:1**; 900×383 is a standard size and needs no
cropping. Render it from HTML with headless Chrome:

```powershell
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
& $chrome --headless=old --disable-gpu --hide-scrollbars `
  --force-device-scale-factor=1 --window-size=900,383 `
  --screenshot="$out.png" "file:///$htmlPath"
```

Start from `templates/cover-900x383.html` and read the rendered PNG back with
`read_image` to confirm it before publishing. Verify the output is exactly
900×383 — a wrong height silently crops.

### Step 2 — write the body

Start from `templates/article-body.html`. **Write the length the article needs** —
there is no 2KB budget to fit into. Sanity-check the documented ceilings only:

```powershell
[System.IO.File]::ReadAllBytes($path).Length
```

**Multi-line structure MUST ride on block elements, never on `white-space`.**

This was a real failure, not a hypothetical. A numbered outline was written as
`<pre>` lines; every text-based check passed, the newlines were verifiably
present in the stored draft, yet inside the WeChat editor the whole outline
**collapsed into one run-on paragraph** — because WeChat's editor overrides the
`white-space` property the `<pre>` was relying on. The author spotted it in the
rendered draft; the pipeline had not.

Rules that follow from it:

- Write each line of a list, outline, or numbered skeleton as its **own `<p>`**.
  A `<p>` breaks by virtue of being block-level, so no property can take that
  away.
- **Do not use `<pre>` for structure**, and do not lean on
  `white-space: pre-wrap` / `pre-line`. Those are styling, and styling is what
  the platform gets to override.
- Indentation inside such a list survives only if it is a **literal character**
  (e.g. an ideographic space `　`), because real leading spaces are exactly what
  collapsed. Use literal characters for nesting.
- `<pre>` remains fine as a *styling* wrapper for a genuine code snippet where
  the content is short and structure is not load-bearing.
- Verify with `scripts/verify.mjs`, which now asserts block-element count and
  absence of `<pre>`; `scripts/test-structure.mjs` regression-tests that check.

### Step 3 — publish

```powershell
$env:WX_APPID="wx..."; $env:WX_SECRET="..."
node <skill-root>/scripts/publish.mjs `
  --title "标题" --digest "摘要" --cover cover.png --content article-body.html
```

Use environment variables rather than CLI flags for credentials so the secret
never lands in shell history or a script file.

### Step 4 — verify, never assume

A returned `media_id` only means the request was accepted. Always read the draft
back and confirm it:

```powershell
node <skill-root>/scripts/verify.mjs <media_id>
```

Expect all checks to pass. Three things are worth checking explicitly because
they are silent failures:

- the body contains **no mojibake** (a UTF-8 encoding mistake upstream);
- **structure is carried by block elements**, not by `white-space` (see the
  structure rule above — this one really did break in production);
- the body is within the **measured** ceilings in the table above
  (100,000 chars / ~300KB), not the 2KB figure the docs still quote.

## Manual path (no API permission)

Fully viable and takes about two minutes:

1. 公众平台 → 草稿箱 → 新的创作 → 写新图文;
2. paste the title and digest;
3. open `article-body.html` in a browser, select all, copy, paste into the
   editor — inline styles survive the paste, so the layout is largely preserved;
4. upload the 900×383 cover (already 2.35:1, no crop needed).

## In-content images and in-place updates

Two gaps the base pipeline does not cover, both hit in production:

**Images inside `content` must be re-hosted.** WeChat strips any `<img src>` that
is not a `mmbiz.qpic.cn` URL, so a body built with local paths lands in the draft
with the figures silently missing. Upload each one through `media/uploadimg` and
rewrite the `src` before calling `draft/add`:

```powershell
node scripts/prepare-publish-body.mjs <body-with-local-images.html> <body-publish.html>
```

**Editing a draft must not create a second draft.** `publish.mjs` always calls
`draft/add`; re-running it after a text fix leaves two drafts in the box.
`draft/update` replaces article 0 in place — note its `articles` field is a
**single object**, not an array:

```powershell
node scripts/update-draft.mjs --media-id <id> --title "..." --thumb <cover media_id> `
  --content <body.html> [--digest "..."] [--author "..."]
```

The cover's `thumb_media_id` stays valid across updates, so keep it rather than
re-uploading the cover every time.

## Layout pitfall that only appears in the editor

The WeChat editor aligns body paragraphs **justified** by default. A line mixing
Chinese with several Latin words (reference lists are the classic case) then gets
stretched until it is full of holes — visible only in the draft, never in the
local HTML. Write `text-align:left` explicitly on paragraphs that carry Latin
words, and give reference entries one line each (name / detail / URL), with the
URL shortened to a directory-level link when the full one is very long.

## IP whitelist: whitelist carriers, not addresses

The egress address can move between carriers mid-project (e.g. China Mobile
`203.0.113.44` → China Telecom Beijing `192.0.2.158`), and a single-address
entry dies the moment the network changes. Add ranges instead —
`223.104.0.0/13` (China Mobile) and `36.112.0.0/16` (CHINANET-BJ, per APNIC RDAP)
— not the address WeChat happened to report in the 40164 message.

## Error code reference

Translate codes for the user instead of echoing raw JSON.

| errcode | Meaning | Fix |
|---|---|---|
| `40164` | caller IP not in whitelist | add the IP named **in the error message** |
| `40013` | bad AppID | not the mini-program / open-platform ID |
| `40125` | bad AppSecret | reset it and re-set the env var |
| `45009` | rate limit | wait for quota reset |
| `45001` | missing `thumb_media_id` | cover upload step failed or was skipped |
| `40007` | invalid `media_id` | the cover was uploaded as a *temporary* material; it must be permanent |

## When a draft seems to have vanished

A draft leaves the box when it is **deleted** or **published** — and publishing
through the WeChat web UI removes it from the box. The API cannot tell you which
happened, so do not guess. Gather evidence instead:

- `draft/get` on the media_id returning `40007 invalid media_id` means the draft
  no longer exists in the box (it existed when the earlier read-back succeeded).
- Run `scripts/account-status.mjs` to see every remaining draft and the total.
- `freepublish/batchget` returning **`48001 api unauthorized`** means the account
  has no publish permission via API — typically a 订阅号. Those accounts are
  published by hand in the web UI, which also removes the draft. So `48001` is
  consistent with "the user published it manually", not proof of it.

Report the evidence and ask which happened rather than asserting one. Then offer
to republish, since that is nearly always what the user wants.

**Observed in practice:** a draft was published by hand in the web UI and
disappeared from the box exactly as described. This is the most common benign
explanation, so ask before treating it as an incident. Two consequences worth
telling the user: the existing draft is often now a **duplicate** of the
published article and can be deleted, and on a 订阅号 the publish step is always
manual.

Note that `draft/add` succeeding says nothing about publish permission: an
account can create drafts while being unable to publish through the API.

## Security

`AppSecret` is equivalent to an account password. Never write it into a script
file, a repo, or a chat log. If it has been exposed anywhere, tell the user to
reset it — rotating costs nothing because the scripts read it from the
environment.

## Files in this skill

| File | Purpose |
|---|---|
| `scripts/publish.mjs` | token → permanent cover upload → `draft/add` |
| `scripts/prepare-publish-body.mjs` | upload in-content images via `media/uploadimg` and rewrite their `src` to `mmbiz` URLs |
| `scripts/update-draft.mjs` | `draft/update` an existing draft in place (no duplicate draft) |
| `scripts/verify.mjs` | read the draft back and run 10 assertions (incl. structure) |
| `scripts/account-status.mjs` | list all drafts + probe whether `freepublish` exists |
| `scripts/test-40164.mjs` | unit tests for the not-whitelisted branch (`node scripts/test-40164.mjs`) |
| `scripts/test-structure.mjs` | regression tests for the block-element structure check |
| `templates/article-body.html` | body starter, pre-sized under 2KB |
| `templates/cover-900x383.html` | dark-tech cover starter, exactly 900×383 |
| `references/api-notes.md` | endpoint and payload details |
