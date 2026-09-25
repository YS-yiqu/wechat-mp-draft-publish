#!/usr/bin/env node
/**
 * 把正文 HTML 里的本地图片逐张上传到微信（media/uploadimg），
 * 替换成微信托管的 URL，输出可直接投递草稿箱的 HTML。
 *
 * 用法：node prepare-publish-body.mjs <源HTML> <输出HTML>
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

const [, , srcArg, outArg] = process.argv;
if (!srcArg || !outArg) { console.error('用法：node prepare-publish-body.mjs <源HTML> <输出HTML>'); process.exit(1); }
const srcPath = path.resolve(srcArg);
const outPath = path.resolve(outArg);
const dir = path.dirname(srcPath);

const appid = readCredential('WX_APPID');
const secret = readCredential('WX_SECRET');
if (!appid || !secret) { console.error('缺少 WX_APPID / WX_SECRET'); process.exit(1); }

const tokRes = await fetch(`${API}/stable_token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ grant_type: 'client_credential', appid, secret, force_refresh: false }),
});
const tok = await tokRes.json();
if (!tok.access_token) {
  console.error('获取 access_token 失败：', JSON.stringify(tok));
  process.exit(tok.errcode === 40164 ? 2 : 1);
}
console.log('✅ access_token 获取成功');

async function uploadImage(abs) {
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : 'image/png';
  const boundary = '----WXInline' + Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${path.basename(abs)}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const res = await fetch(`${API}/media/uploadimg?access_token=${encodeURIComponent(tok.access_token)}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, buf, tail]),
  });
  const data = await res.json();
  if (!data.url) throw new Error(`上传失败 ${path.basename(abs)}: ${JSON.stringify(data)}`);
  return data.url;
}

let html = fs.readFileSync(srcPath, 'utf8');
const srcs = [...html.matchAll(/<img\s+src="([^"]+)"/g)].map((m) => m[1]);
const uniq = [...new Set(srcs)];
console.log('待上传图片：', uniq.length, '张');

for (const s of uniq) {
  if (/^https?:/i.test(s)) { console.log('· 已是网络地址，跳过：', s); continue; }
  const abs = path.join(dir, s);
  if (!fs.existsSync(abs)) { console.error('图片不存在：' + abs); process.exit(1); }
  const url = await uploadImage(abs);
  const safe = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  html = html.replace(new RegExp(`<img\\s+src="${safe}"`, 'g'), `<img src="${url}"`);
  console.log('· 已上传', s, '→', url.slice(0, 68) + '…');
}

fs.writeFileSync(outPath, html, 'utf8');
console.log('✅ 已写出发布用正文：' + outPath);
