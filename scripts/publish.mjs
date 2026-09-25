#!/usr/bin/env node
/**
 * WeChat Official Account draft publisher.
 * ------------------------------------------------------------------
 * Flow: stable_token -> upload cover as PERMANENT material (thumb_media_id)
 *       -> draft/add
 *
 * Credentials come from the environment ONLY (never CLI flags, so the secret
 * stays out of shell history):
 *   WX_APPID, WX_SECRET
 *
 * Usage:
 *   node publish.mjs --title "标题" --digest "摘要" \
 *                    --cover cover.png --content article-body.html \
 *                    [--author "作者"] [--source-url "https://..."] \
 *                    [--no-comment] [--fans-only]
 *
 * Exit codes: 0 ok, 1 any failure, 2 caller IP not whitelisted (actionable).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = 'https://api.weixin.qq.com/cgi-bin';

/* ------------------------------------------------------------------ *
 * Content size limits.
 *
 * The docs claim `content` "大小不可超过 2kb", and an earlier version of this
 * script enforced that as a hard 2048-byte limit — rejecting larger bodies and
 * forcing needless trimming of otherwise fine articles.
 *
 * That was WRONG. Measured against the live API: 4,279 B and 36,939 B both
 * accepted and stored intact. Nor do the other documented figures hold up:
 *
 *   field     docs say      measured (bisected against the live API)
 *   title     ≤32 chars     64 chars   (65 rejected, errcode 45003)
 *   digest    ≤120 chars    120 chars  (121 rejected, errcode 45004)  ✓ matches
 *   content   <20k chars    100,000 chars (~300KB) still accepted
 *
 * The limits below are the MEASURED ones. Keep the margin generous: these were
 * bisected on one account on one day, and WeChat can tighten them server-side
 * without notice. When a value here is ever changed, re-run
 * `scripts/probe-limits.mjs` rather than trusting a doc.
 * ------------------------------------------------------------------ */
const CONTENT_LIMIT = 300 * 1024;    // 实测 10 万字符/约 300KB 仍通过；留余量
const CONTENT_CHAR_LIMIT = 200000;   // 实测通过上限的 2 倍，仅作异常拦截
const TITLE_LIMIT = 64;              // 实测 64（文档称 32，实测翻倍）
const DIGEST_LIMIT = 120;            // 实测 120（与文档一致）

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error('\n❌ ' + msg); process.exit(1); };

/* ----------------------------- args ----------------------------- */
function parseArgs(argv) {
  const out = { comment: true, fansOnly: false };
  const flagMap = {
    '--title': 'title', '--digest': 'digest', '--cover': 'cover',
    '--content': 'content', '--author': 'author', '--source-url': 'sourceUrl',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-comment') { out.comment = false; continue; }
    if (a === '--fans-only') { out.fansOnly = true; continue; }
    const key = flagMap[a];
    if (!key) fail(`未知参数：${a}\n   运行 node publish.mjs --help 查看用法`);
    const val = argv[++i];
    if (val === undefined) fail(`参数 ${a} 缺少取值`);
    out[key] = val;
  }
  return out;
}

function printUsage() {
  log(`用法：
  node publish.mjs --title "标题" --digest "摘要" --cover cover.png --content body.html
  可选：--author "作者"  --source-url "https://..."  --no-comment  --fans-only
凭证：环境变量 WX_APPID / WX_SECRET`);
}

/* --------------------------- helpers ---------------------------- */
function readOrFail(p, label) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) fail(`${label}不存在：${abs}`);
  return { buf: fs.readFileSync(abs), abs };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),   // UTF-8, Chinese passed literally (no \uXXXX)
  });
  return res.json();
}

const ERR_HINT = {
  40164: '当前机器 IP 不在公众号 IP 白名单内 → 见下方自动提示，直接把报出的 IP 加进白名单即可',
  40013: 'AppID 不正确（注意不是小程序或开放平台的 ID）',
  40125: 'AppSecret 不正确 → 重置后重新设置环境变量',
  45009: '接口调用次数超限，请等待配额重置',
  45001: '缺少 thumb_media_id → 封面素材上传失败或被跳过',
  40007: 'media_id 无效 → 封面必须是「永久素材」，临时素材不行',
  89503: '未授权或授权已过期',
};

/* ------------------------------------------------------------------ *
 * Egress-IP self-check.
 *
 * This machine's public IP CHANGES across network switches, and WeChat
 * rejects any call whose source IP is not whitelisted (40164). Rather than
 * relying on anyone remembering to check, resolve the egress IP up front,
 * report it, and tie it to the carrier so the user can whitelist a RANGE
 * instead of a single address.
 *
 * Caveat: an IP-lookup service does not necessarily see the same egress IP
 * WeChat does (a proxy can route them differently). So this is advisory. The
 * authoritative value is the IP WeChat names in an 40164 message, and that
 * path is handled in getAccessToken below.
 * ------------------------------------------------------------------ */
/**
 * Map an egress IPv4 to its carrier and suggest a whitelist range.
 *
 * Ranges below are carrier allocations, not guesses:
 *   - 223.104.0.0/13  China Mobile (mobile data) — mobile and hotspot egress.
 *   - 123.112.0.0/12  China Unicom Beijing (APNIC handle UNICOM-BJ,
 *                     verified via RDAP) — fixed-line egress in Beijing.
 * The `range` returned is deliberately the **tighter /24** around the observed
 * address, because whitelisting a whole /12 is a large security concession.
 * `allocation` records the parent block so the message can offer it explicitly
 * when the residual flapping risk matters more than the exposure.
 */
const CARRIER_RANGES = [
  { test: (a, b) => a === 223 && b >= 104 && b <= 111, name: '中国移动', allocation: '223.104.0.0/13' },
  { test: (a) => a === 117, name: '中国移动', allocation: null },
  { test: (a, b) => a === 123 && b >= 112 && b <= 127, name: '中国联通（北京）', allocation: '123.112.0.0/12' },
  { test: (a, b) => a === 112 && b === 90, name: '中国联通', allocation: null },
  { test: (a, b) => a === 113 && b === 24, name: '中国电信', allocation: null },
];

function carrierOf(ip) {
  if (!ip) return null;
  if (ip.includes(':')) return { name: 'IPv6 地址', range: null, allocation: null, volatile: true };
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return null;
  const [a, b, c] = p;
  if (a === 10 || a === 172 || a === 192) {
    return { name: '内网地址（说明出网被代理）', range: null, allocation: null, volatile: true };
  }
  const hit = CARRIER_RANGES.find((r) => r.test(a, b));
  const range = `${a}.${b}.${c}.0/24`;
  if (hit) return { ...hit, range, volatile: true };
  return { name: '未知运营商', range, allocation: null, volatile: true };
}

async function reportEgressIp() {
  const providers = [
    { url: 'https://myip.ipip.net', text: true },
    { url: 'https://api.ipify.org?format=json', text: false },
  ];
  const seen = [];
  for (const p of providers) {
    try {
      const ctl = AbortSignal.timeout(8000);
      const res = await fetch(p.url, { signal: ctl });
      if (p.text) {
        const t = (await res.text()).trim();
        // Capture IPv4 AND IPv6: a dual-stack host can report v6 here while the
        // WeChat call egresses over v4, which makes a v4-only reading misleading.
        const v4 = t.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
        const v6 = t.match(/\b((?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4})\b/i);
        if (v4) seen.push({ ip: v4[1], raw: t });
        else if (v6) seen.push({ ip: v6[1], raw: t });
      } else {
        const j = await res.json();
        if (j.ip) seen.push({ ip: j.ip, raw: j.ip });
      }
    } catch { /* lookup is best-effort; never block publishing on it */ }
  }
  if (!seen.length) {
    log('⚠️  无法自动探测出口 IP（网络或查询服务不可用）。若报 40164，请用错误信息里的 IP。');
    return;
  }

  log('🌐 出口 IP 自检（仅供参考，微信实际看到的可能是另一个）：');
  for (const s of seen) {
    const c = carrierOf(s.ip);
    log(`   ${s.ip}  ${c ? '· ' + c.name : ''}`);
  }
  const v4s = seen.map((s) => s.ip).filter((i) => !i.includes(':'));
  const distinct = [...new Set(seen.map((s) => s.ip))];
  if (distinct.length > 1) {
    log('   ⚠️ 多个查询服务返回了不同 IP　→　你在走代理/双栈，微信看到的出口 IP 未必是上面这些。');
    log('      以 40164 报错中微信明确指出的那个 IP 为准。');
  }
  if (!v4s.length) {
    log('   ⚠️ 只探测到 IPv6：微信服务端接口通常按 IPv4 校验白名单，故上面的地址可能不是被拒的那个。');
    log('      仍以 40164 报错里的 IPv4 为准。');
  }

  const c = carrierOf(v4s[0] || distinct[0]);
  if (c && c.volatile) {
    log(`\n💡 提醒：${c.name} 的公网 IP 会随重拨/切网变化，这正是 40164 反复出现的原因。`);
    log('   根治办法：不要把白名单填成单个 IP，而是填 IP 段（公众号支持 CIDR）。');
    if (c.range) log(`   建议加入白名单：${c.range}　←　覆盖你当前地址段`);
    if (c.allocation) {
      log(`   若该 /24 之后仍然失效，说明运营商在更大范围内换地址，可放宽到 ${c.allocation}`);
      log('   （段越大越省事，但也意味着把更多地址放进了白名单，自行权衡）');
    }
    log('   路径：微信开发者平台 → 我的业务 → 公众号 → 基础信息 → 开发信息 → API IP 白名单');
    log('   （不是「开发-基本配置」那个入口；白名单支持填多个，也可以用 IP 段）');
  }
}

/**
 * Build the ONE-CLICK link to this account's 开发信息 page (where the IP
 * whitelist lives).
 *
 * Pattern verified against the URL the user actually authorized from:
 *   https://developers.weixin.qq.com/console/product/mp/<APPID>?tab1=basicInfo&tab2=dev
 *
 * Why this shape and not a generic entry page: the user explicitly asked not to
 * be made to click through several levels. The link is per-account (it embeds
 * the AppID) but contains NO session token, so it is safe to print and safe to
 * store — it does not expire and leaks nothing.
 */
export function consoleUrlFor(appid = process.env.WX_APPID) {
  if (!appid) return null;
  return `https://developers.weixin.qq.com/console/product/mp/${appid}?tab1=basicInfo&tab2=dev`;
}

/**
 * Handle an 40164 (caller IP not whitelisted) response.
 *
 * Extracted with injected output + exit so this branch can be tested without
 * actually being locked out of the account. Returns the exit code to use.
 */
export function handleNotWhitelisted(errmsg, out = console.error.bind(console)) {
  const m = String(errmsg || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  const ip = m ? m[1] : null;
  const c = carrierOf(ip);
  out('\n' + '─'.repeat(64));
  out('❌ 被微信拒绝：当前出口 IP 不在白名单内（errcode 40164）');
  out('─'.repeat(64));
  if (ip) {
    out(`\n👉 微信看到的出口 IP 是：${ip}${c ? '（' + c.name + '）' : ''}`);
    out('   这是权威值——以它为准，不要相信 IP 查询网站的结果。');
    if (c && c.volatile) {
      out('   这个运营商的公网 IP 会随重拨/切网变化，所以以后可能还会变。');
    }
    const url = consoleUrlFor();
    out('\n🔗 点这个链接直达白名单页面（本账号专用，一次点击）：');
    if (url) {
      out(`   ${url}`);
    } else {
      // No WX_APPID in the environment: fall back to the generic console.
      out('   https://developers.weixin.qq.com/platform/');
      out('   （未读到 WX_APPID，需自行进入 我的业务 → 公众号 → 基础信息 → 开发信息）');
    }
    if (c && c.range) {
      out('\n💡 不要只填单个 IP——改填 IP 段以免疫重拨：');
      out(`     ${c.range}　←　直接复制这条`);
      if (c.allocation) {
        out(`   若它之后仍失效，说明运营商换到了该段的其它区块，再放宽到 ${c.allocation}`);
      }
    }
    out('\n   加完（约 10 分钟内生效）后重跑本脚本即可。');
  } else {
    out(`\n   原始报错：${errmsg}`);
    out('   请把报错中的 IP 加入 API IP 白名单后重跑。');
  }
  out('─'.repeat(64) + '\n');
  return 2;   // distinct code so callers can detect "needs whitelist"
}

/**
 * Read a credential, falling back to the Windows user environment registry.
 *
 * Why the fallback: a long-running shell (or this DSH session) predates the
 * moment the user set the variable, and Windows does not retroactively update
 * the environment block of an already-running process. The registry value under
 * HKCU\Environment is authoritative and live, so read it there rather than
 * telling the user to restart.
 */
function readCredential(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    // 形如：    WX_APPID    REG_SZ    wx4de...
    const m = out.match(new RegExp(name + '\\s+REG_SZ\\s+(.*)'));
    const v = m ? m[1].trim() : '';
    if (v) {
      process.env[name] = v;   // 缓存到本进程，后续调用不再查注册表
      return v;
    }
  } catch { /* 未设置或非 Windows：按缺失处理 */ }
  return undefined;
}

async function getAccessToken() {
  const appid = readCredential('WX_APPID');
  const secret = readCredential('WX_SECRET');
  if (!appid || !secret) {
    const missing = [!appid && 'WX_APPID', !secret && 'WX_SECRET'].filter(Boolean).join('、');
    fail(
      `缺少凭据：${missing}\n` +
      '   本脚本会依次查找：进程环境变量 → 用户环境变量注册表(HKCU\\Environment)。\n' +
      '   请设置用户环境变量（一次即可，永久生效）：\n' +
      '     setx WX_APPID "wx..."\n' +
      '     setx WX_SECRET "..."\n' +
      '   或在「编辑用户环境变量」界面新增这两项。设置后无需重启，重跑本脚本即可。'
    );
  }

  log('⏳ 正在获取 access_token ...');
  const data = await postJson(`${API}/stable_token`, {
    grant_type: 'client_credential', appid, secret, force_refresh: false,
  });
  if (data.access_token) {
    log(`✅ access_token 获取成功（有效期 ${data.expires_in}s）`);
    return data.access_token;
  }

  // --- 40164: the egress IP is not whitelisted. Make the fix unmissable. ---
  if (data.errcode === 40164) {
    process.exit(handleNotWhitelisted(data.errmsg));
  }

  const hint = ERR_HINT[data.errcode] || '请对照官方文档排查';
  fail(`获取 access_token 失败：errcode=${data.errcode} errmsg=${data.errmsg}\n   💡 ${hint}`);
}

/** Upload as PERMANENT material — required for thumb_media_id. */
async function uploadCover(token, filePath) {
  const { buf, abs } = readOrFail(filePath, '封面图');
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
             : ext === '.gif' ? 'image/gif' : 'image/png';
  const boundary = '----WXFormBoundary' + Date.now().toString(16);

  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${path.basename(abs)}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, buf, tail]);

  const res = await fetch(
    `${API}/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
    { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body }
  );
  const data = await res.json();
  if (!data.media_id) {
    fail(`封面上传失败：errcode=${data.errcode} errmsg=${data.errmsg}\n   💡 ${ERR_HINT[data.errcode] || ''}`);
  }
  log(`✅ 封面已上传为永久素材 → ${data.media_id}`);
  return data.media_id;
}

/* ----------------------------- main ----------------------------- */
async function main(args) {
  log('=== 微信公众号草稿发布器 ===\n');

  if (!args.title) fail('缺少 --title');
  if (!args.content) fail('缺少 --content');
  if (!args.cover) fail('缺少 --cover（封面图，必须是本地文件）');

  const { buf: bodyBuf, abs: bodyPath } = readOrFail(args.content, '正文 HTML');
  const content = bodyBuf.toString('utf8');
  const bytes = Buffer.byteLength(content, 'utf8');

  log(`📄 正文：${bodyPath}`);
  // 体积不是风格预算：实测 300KB 上限，正常文章远不会触界。
  const chars = content.length;
  log(`   体积 ${bytes} 字节 / ${chars} 字符（上限约 ${Math.round(CONTENT_LIMIT / 1024)}KB，仅供参考）`);
  if (bytes >= CONTENT_LIMIT || chars >= CONTENT_CHAR_LIMIT) {
    fail(
      `正文 ${bytes} 字节 / ${chars} 字符，超出实测可用上限。\n` +
      '   处理方式：拆成多条图文（一篇图文可含多条）。\n' +
      '   注意：不要为了体积而删减内容——先跑 scripts/probe-limits.mjs 确认边界。'
    );
  }
  if (args.title.length > TITLE_LIMIT) fail(`标题 ${args.title.length} 字，超过 ${TITLE_LIMIT} 字限制`);
  if (args.digest && args.digest.length > DIGEST_LIMIT) fail(`摘要 ${args.digest.length} 字，超过 ${DIGEST_LIMIT} 字限制`);

  // Self-check the egress IP FIRST: if it changed since the last run, say so
  // here rather than letting a 40164 be the surprise.
  await reportEgressIp();
  log('');

  const token = await getAccessToken();
  const thumbMediaId = await uploadCover(token, args.cover);

  const article = {
    article_type: 'news',
    title: args.title,
    content,
    thumb_media_id: thumbMediaId,
    need_open_comment: args.comment ? 1 : 0,
    only_fans_can_comment: args.fansOnly ? 1 : 0,
  };
  if (args.digest) article.digest = args.digest;   // empty -> WeChat auto-grabs first 54 chars
  if (args.author) article.author = args.author;
  if (args.sourceUrl) article.content_source_url = args.sourceUrl;

  log('\n⏳ 正在写入草稿箱 ...');
  const result = await postJson(
    `${API}/draft/add?access_token=${encodeURIComponent(token)}`,
    { articles: [article] }
  );

  if (!result.media_id) {
    fail(`写入草稿失败：errcode=${result.errcode} errmsg=${result.errmsg}\n   💡 ${ERR_HINT[result.errcode] || ''}`);
  }

  log('\n🎉 草稿已存入草稿箱');
  log(`   media_id: ${result.media_id}`);
  log('\n下一步（务必执行）：读回草稿核对内容是否与预期一致：');
  log(`   node ${path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'verify.mjs')} ${result.media_id}`);
  log('\n提醒：若 AppSecret 曾出现在聊天记录或代码仓库中，请到公众平台重置它。');
}

/* ------------------------------------------------------------------ *
 * CLI entry guard.
 *
 * Run the workflow ONLY when this file is executed directly. Without this,
 * importing the module (as test-40164.mjs does to reach the exported handler)
 * would immediately run the CLI, parse the test runner's argv, and die on
 * "缺少 --title". It also makes this file safely reusable as a library.
 * ------------------------------------------------------------------ */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  // --help must be checked BEFORE arg parsing, so it is never rejected as an
  // unknown flag.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    process.exit(0);
  }
  main(parseArgs(process.argv)).catch((e) => fail(e.stack || String(e)));
}
