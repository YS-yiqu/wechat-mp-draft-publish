/**
 * 约束探测工具（通用）
 *
 * 起因：把官方文档的「content 不可超过 2kb」当成硬限制，据此压缩文章并加了拒绝
 * 守卫。实测 37KB 通过 —— 文档数字与运行时不符。
 *
 * 教训：**引用任何限制前，先探测它是否真的被强制执行。**
 * 本工具探测 title / digest / content 三者的真实边界。
 */
const API = 'https://api.weixin.qq.com/cgi-bin';
const appid = process.env.WX_APPID, secret = process.env.WX_SECRET;
if (!appid || !secret) { console.error('缺少 WX_APPID / WX_SECRET'); process.exit(1); }

async function post(u, b) {
  const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(b) });
  return r.json();
}
const tok = (await post(`${API}/stable_token`, { grant_type: 'client_credential', appid, secret })).access_token;
const T = encodeURIComponent(tok);

const list = await post(`${API}/draft/batchget?access_token=${T}`, { offset: 0, count: 1, no_content: 0 });
const thumb = list.item?.[0]?.content?.news_item?.[0]?.thumb_media_id;
if (!thumb) { console.error('取不到可复用封面素材'); process.exit(1); }

/** 试着提交一篇草稿；成功则删除并返回 ok，失败返回错误码 */
async function attempt(label, article) {
  const res = await post(`${API}/draft/add?access_token=${T}`, { articles: [article] });
  if (res.media_id) {
    await post(`${API}/draft/delete?access_token=${T}`, { media_id: res.media_id });
    return { ok: true };
  }
  return { ok: false, errcode: res.errcode, errmsg: res.errmsg };
}

const base = { article_type: 'news', content: '<p>探测用正文</p>', thumb_media_id: thumb, need_open_comment: 0 };

console.log('=== 探测 title 长度上限（文档称 ≤32 字）===');
for (const n of [32, 33, 40, 64, 100, 200]) {
  const title = '标'.repeat(n);
  const r = await attempt('title', { ...base, title });
  console.log(`  ${String(n).padStart(3)} 字 → ${r.ok ? '接受 ✓' : `拒绝 ✗ errcode=${r.errcode}`}`);
  if (!r.ok) break;
}

console.log('\n=== 探测 digest 长度上限（文档称 ≤120 字）===');
for (const n of [120, 121, 200, 400, 1000]) {
  const digest = '摘'.repeat(n);
  const r = await attempt('digest', { ...base, title: 'digest 探测', digest });
  console.log(`  ${String(n).padStart(4)} 字 → ${r.ok ? '接受 ✓' : `拒绝 ✗ errcode=${r.errcode}`}`);
  if (!r.ok) break;
}

console.log('\n=== 探测 content 字符上限（文档称 <2 万字符）===');
for (const n of [20000, 20001, 30000]) {
  const content = '<p>' + '正'.repeat(Math.max(1, n - 7)) + '</p>';
  const chars = content.length;
  const r = await attempt('content', { ...base, title: 'content 探测', content });
  console.log(`  ${String(chars).padStart(6)} 字符 → ${r.ok ? '接受 ✓' : `拒绝 ✗ errcode=${r.errcode}`}`);
  if (!r.ok) { console.log('    （已触界，停止上探）'); break; }
}

console.log('\n完成。结论请回填到 SKILL.md 的约束表，并标注「已实测」或「照文档」。');
