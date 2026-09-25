#!/usr/bin/env node
/**
 * Read a WeChat draft back and assert it landed correctly.
 * ------------------------------------------------------------------
 * A returned media_id only proves the request was ACCEPTED. This script proves
 * what is actually stored, which is where silent failures show up: mojibake
 * from an encoding mistake, an over-limit body, or a cover that never bound.
 *
 * Usage:
 *   node verify.mjs <media_id>
 *   node verify.mjs --list          # show recent drafts
 *
 * Credentials: WX_APPID / WX_SECRET — process env, else HKCU\Environment.
 */

import { execFileSync } from 'node:child_process';

const API = 'https://api.weixin.qq.com/cgi-bin';
const fail = (msg) => { console.error('\n❌ ' + msg); process.exit(1); };

/**
 * Read a credential: process env first, then the Windows user environment
 * registry. A running shell never sees variables set after it started, so the
 * registry is the only live source — do not make the user restart anything.
 */
function readCredential(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(new RegExp(name + '\\s+REG_SZ\\s+(.*)'));
    const v = m ? m[1].trim() : '';
    if (v) { process.env[name] = v; return v; }
  } catch { /* 未设置 */ }
  return undefined;
}

const arg = process.argv[2];
if (!arg) fail('用法：node verify.mjs <media_id>  或  node verify.mjs --list');

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function token() {
  const appid = readCredential('WX_APPID'), secret = readCredential('WX_SECRET');
  if (!appid || !secret) {
    fail('缺少 WX_APPID / WX_SECRET。请设置用户环境变量：setx WX_APPID "wx..." / setx WX_SECRET "..."');
  }
  const d = await postJson(`${API}/stable_token`, {
    grant_type: 'client_credential', appid, secret, force_refresh: false,
  });
  if (!d.access_token) fail(`取 access_token 失败：errcode=${d.errcode} errmsg=${d.errmsg}`);
  return d.access_token;
}

const t = await token();
console.log('✅ access_token OK\n');

/* ------------------------------ list mode ------------------------------ */
if (arg === '--list') {
  const d = await postJson(`${API}/draft/batchget?access_token=${encodeURIComponent(t)}`, {
    offset: 0, count: 10, no_content: 1,
  });
  if (!d.item) fail(`读取草稿列表失败：errcode=${d.errcode} errmsg=${d.errmsg}`);
  console.log(`草稿总数：${d.total_count}`);
  for (const it of d.item) {
    const n = it.content?.news_item?.[0];
    console.log(`  ${it.media_id}  ${n?.title ?? '(无标题)'}`);
  }
  process.exit(0);
}

/* ----------------------------- verify mode ----------------------------- */
const detail = await postJson(
  `${API}/draft/get?access_token=${encodeURIComponent(t)}`, { media_id: arg }
);
if (!detail.news_item) fail(`读取草稿失败：errcode=${detail.errcode} errmsg=${detail.errmsg}`);

const it = detail.news_item[0];
const bytes = Buffer.byteLength(it.content || '', 'utf8');
const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');

// `body` must be defined before first use — it feeds both the summary lines
// below and the structure checks further down.
const body = it.content || '';

console.log('===== 草稿实际内容 =====');
console.log('标题    :', it.title, `(${it.title.length} 字)`);
console.log('作者    :', it.author || '(空)');
console.log('摘要    :', it.digest, `(${it.digest.length} 字)`);
console.log('封面ID  :', it.thumb_media_id || '(未绑定)');
console.log('封面URL :', it.thumb_url || '(无)');
console.log('正文字节:', bytes, `(${body.length} 字符)`, bytes < 300 * 1024 ? '✓' : '✗ 异常偏大');
console.log('评论    :', it.need_open_comment === 1 ? '已开启' : '未开启');
console.log('原文链接:', it.content_source_url || '(未设置)');

console.log('\n----- 正文文本预览 -----');
console.log(strip(body).split('\n').map(s => s.trim()).filter(Boolean).join('\n'));

console.log('\n===== 关键项核对 =====');
const src = it.content_source_url || '';

/* ------------------------------------------------------------------ *
 * Structure checks.
 *
 * Learned the hard way: this script used to strip tags and check the text,
 * which CANNOT see lost line structure. A body whose list was written with
 * <pre> + white-space collapsed into one run-on paragraph inside the WeChat
 * editor while every text-based assertion still passed.
 *
 * Rule: multi-line structure must ride ON BLOCK ELEMENTS (<p>, <div>, <li>,
 * headings), never on white-space. So assert that block elements exist and
 * warn when the body relies on <pre>/white-space instead.
 * ------------------------------------------------------------------ */
const blockCount = (body.match(/<(p|div|li|h[1-6]|tr)[\s>]/gi) || []).length;
const preCount = (body.match(/<pre[\s>]/gi) || []).length;
const usesWhitespaceReliance = /white-space\s*:\s*(pre|pre-wrap|pre-line)/i.test(body);

const checks = [
  ['标题非空', !!it.title],
  // 以下阈值均为对线上接口实测所得，非照抄文档（见 SKILL.md 约束表）
  ['标题 ≤64 字（实测上限）', (it.title || '').length <= 64],
  ['摘要 ≤120 字（实测上限）', (it.digest || '').length <= 120],
  ['正文非空', bytes > 0],
  ['正文 <300KB（实测通过值）', bytes < 300 * 1024],
  ['封面 media_id 已绑定', !!it.thumb_media_id],
  ['正文含中文（无乱码）', /[\u4e00-\u9fa5]/.test(body)],
  ['正文含可见文字（去标签后非空）', strip(body).trim().length > 0],
  ['无 HTML 转义残留（&lt; 等）', !/&lt;|&gt;|&amp;lt;/.test(body)],
  // 结构可用性：多行内容必须有块级元素承载，否则微信编辑器会塌成一整段
  ['结构由块级元素承载（≥5 个 p/div/li/标题）', blockCount >= 5],
  ['未依赖 <pre> 承载多行结构', preCount === 0],
  ...(process.env.EXPECT_SOURCE_URL
    ? [['原文链接已写入且与预期一致', src === process.env.EXPECT_SOURCE_URL]]
    : []),
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (ok) pass++;
}
console.log(`  ℹ 块级元素 ${blockCount} 个，<pre> ${preCount} 个，依赖 white-space：${usesWhitespaceReliance ? '是' : '否'}`);
console.log(`\n结果：${pass}/${checks.length} 项通过`);
if (pass < checks.length) {
  console.log('\n未通过项说明：');
  console.log('  乱码通常是上游 UTF-8 编码错误；封面未绑定说明封面被当成了临时素材；');
  console.log('  原文链接不一致说明 --source-url 未正确传入或微信未回存该字段；');
  console.log('  结构项失败说明正文可能被微信编辑器塌成整段 —— 把 <pre> 改为每行一个 <p>。');
  process.exit(1);
}
