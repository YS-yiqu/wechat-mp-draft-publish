#!/usr/bin/env node
/**
 * Diagnose the account: draft totals, full draft listing, and whether the
 * publish (freepublish) capability exists.
 * ------------------------------------------------------------------
 * Use this when a draft seems to have vanished from the draft box. A draft
 * leaves the box when it is DELETED or PUBLISHED, and the API cannot tell you
 * which — but this script narrows it down.
 *
 * Usage: node account-status.mjs
 * Credentials: WX_APPID / WX_SECRET — process env, else HKCU\Environment
 * (a running shell does not see variables set after it started, so fall back
 * to the registry rather than making the user restart anything).
 */

import { execFileSync } from 'node:child_process';

const API = 'https://api.weixin.qq.com/cgi-bin';

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

const appid = readCredential('WX_APPID'), secret = readCredential('WX_SECRET');
if (!appid || !secret) {
  console.error('缺少 WX_APPID / WX_SECRET。请设置用户环境变量：');
  console.error('  setx WX_APPID "wx..."   /   setx WX_SECRET "..."');
  process.exit(1);
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const tok = await post(`${API}/stable_token`, { grant_type: 'client_credential', appid, secret, force_refresh: false });
if (!tok.access_token) {
  console.error('取 token 失败:', JSON.stringify(tok));
  if (tok.errcode === 40164) {
    const m = String(tok.errmsg || '').match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    const ip = m ? m[1] : '(见上方报错)';
    const p = String(ip).split('.').map(Number);
    console.error('\n👉 这是 IP 白名单问题（40164），不是脚本问题。');
    console.error(`   微信看到的出口 IP：${ip}`);
    console.error('   点这个链接直达白名单页面（本账号专用，一次点击）：');
    console.error(`     https://developers.weixin.qq.com/console/product/mp/${appid}?tab1=basicInfo&tab2=dev`);
    if (p.length === 4 && !p.some(Number.isNaN)) {
      console.error(`   建议填 IP 段（可免疫重拨）：${p[0]}.${p[1]}.0.0/16`);
    }
    console.error('   约 10 分钟生效。发布脚本 publish.mjs 会给出同样的指引。');
  }
  process.exit(tok.errcode === 40164 ? 2 : 1);
}
const T = encodeURIComponent(tok.access_token);

console.log('=== 草稿箱 ===');
const cnt = await post(`${API}/draft/count?access_token=${T}`, {});
console.log('总数:', cnt.total_count ?? JSON.stringify(cnt));

const list = await post(`${API}/draft/batchget?access_token=${T}`, { offset: 0, count: 20, no_content: 0 });
for (const [i, it] of (list.item || []).entries()) {
  const n = it.content?.news_item?.[0] || {};
  console.log(`[${i + 1}] ${n.title ?? '(无标题)'}`);
  console.log(`    media_id : ${it.media_id}`);
  console.log(`    作者     : ${n.author || '(空)'}`);
  console.log(`    正文字节 : ${Buffer.byteLength(n.content || '', 'utf8')}`);
  console.log(`    摘要     : ${(n.digest || '(空)').slice(0, 50)}`);
}

console.log('\n=== 发表能力 freepublish ===');
const pub = await post(`${API}/freepublish/batchget?access_token=${T}`, { offset: 0, count: 10, no_content: 1 });
if (pub.errcode === 48001) {
  console.log('❌ 无 freepublish 权限（48001）→ 该账号通常是订阅号，不能通过接口发表；请在后台手动发表。');
} else if (pub.errcode) {
  console.log('返回错误:', JSON.stringify(pub));
} else {
  console.log('已发布条目数:', pub.total_count);
  for (const it of (pub.item || [])) {
    const n = it.content?.news_item?.[0] || {};
    console.log(`  ${n.title ?? '(无标题)'}  update_time=${it.update_time}`);
  }
}

console.log('\n=== 草稿箱开关 ===');
const sw = await post(`${API}/draft/switch?access_token=${T}`, {});
console.log(JSON.stringify(sw));
