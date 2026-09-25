#!/usr/bin/env node
/**
 * 就地更新公众号草稿（draft/update），避免改一次多一条草稿。
 *
 * 用法：
 *   node update-draft.mjs --media-id <草稿media_id> --title "..." [--digest "..."] \
 *        --content <正文HTML> --thumb <封面永久素材media_id> [--author "..."]
 *
 * 说明：draft/update 的 articles 是单个对象（不是数组）。
 * 凭据读取顺序同 publish.mjs：进程环境 → HKCU\Environment。
 */
import fs from 'node:fs';
import path from 'node:path';
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
  } catch { /* ignore */ }
  return undefined;
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  const v = process.argv[i + 1];
  args[k.replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
}
if (!args.mediaId || !args.title || !args.content || !args.thumb) {
  console.error('用法：node update-draft.mjs --media-id <id> --title <标题> --content <正文HTML> --thumb <封面media_id> [--digest <摘要>] [--author <作者>]');
  process.exit(1);
}

const appid = readCredential('WX_APPID');
const secret = readCredential('WX_SECRET');
if (!appid || !secret) { console.error('缺少 WX_APPID / WX_SECRET'); process.exit(1); }

const tokRes = await fetch(`${API}/stable_token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ grant_type: 'client_credential', appid, secret, force_refresh: false }),
});
const tok = await tokRes.json();
if (!tok.access_token) { console.error('获取 access_token 失败：', JSON.stringify(tok)); process.exit(1); }
console.log('✅ access_token 获取成功');

const content = fs.readFileSync(path.resolve(args.content), 'utf8');
const article = {
  article_type: 'news',
  title: args.title,
  content,
  thumb_media_id: args.thumb,
  need_open_comment: 1,
  only_fans_can_comment: 0,
};
if (args.digest) article.digest = args.digest;
if (args.author) article.author = args.author;

const res = await fetch(`${API}/draft/update?access_token=${encodeURIComponent(tok.access_token)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ media_id: args.mediaId, index: 0, articles: article }),
});
const out = await res.json();
if (out.errcode && out.errcode !== 0) {
  console.error('❌ 更新草稿失败：', JSON.stringify(out));
  process.exit(1);
}
console.log('🎉 草稿已就地更新：' + args.mediaId);
