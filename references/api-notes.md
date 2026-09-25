# WeChat MP API notes

Verified against the official docs at
<https://developers.weixin.qq.com/doc/service/api/draftbox/draftmanage/api_draft_add.html>.

## Endpoints used

| Step | Endpoint |
|---|---|
| token | `POST https://api.weixin.qq.com/cgi-bin/stable_token` |
| cover | `POST https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=X&type=image` |
| draft | `POST https://api.weixin.qq.com/cgi-bin/draft/add?access_token=X` |
| read back | `POST https://api.weixin.qq.com/cgi-bin/draft/get` |
| list | `POST https://api.weixin.qq.com/cgi-bin/draft/batchget` |

`stable_token` body:

```json
{ "grant_type": "client_credential", "appid": "...", "secret": "...", "force_refresh": false }
```

Preferred over `cgi-bin/token` because it is the stable-credential endpoint. Note
WeChat may still invalidate a previously issued token when a new one is minted
elsewhere, so treat 40001/42001 responses as "re-fetch the token and retry once".

## draft/add payload

```json
{
  "articles": [
    {
      "article_type": "news",
      "title": "≤32 字",
      "author": "≤16 字（可选）",
      "digest": "≤120 字（可选；留空则自动抓取正文前 54 字）",
      "content": "<2KB HTML",
      "content_source_url": "原文链接（可选）",
      "thumb_media_id": "永久素材 ID（图文消息必填）",
      "need_open_comment": 0,
      "only_fans_can_comment": 0
    }
  ]
}
```

Response: `{ "media_id": "..." }`.

## Cover / thumbnail rules

- `thumb_media_id` **must be a permanent material ID**. Temporary material IDs
  fail. This is why `add_material` (permanent) is used instead of
  `media/upload` (temporary).
- WeChat **re-encodes** the uploaded cover. Reading the draft back commonly shows
  a `mmbiz.qpic.cn` URL with `wx_fmt=jpeg` even when a PNG was uploaded. This is
  normal platform behaviour, not a bug in the upload.
- Cover ratio for 图文消息 is **2.35:1**; 900×383 matches it exactly.
- `cover_info.crop_percent_list` can express crops in a 0..1 coordinate system
  with `ratio` of `2.35_1` or `1_1`. Unnecessary when the source image is already
  2.35:1.

## `content` rules

- Must be **under 2KB** and under 20,000 characters. WeChat strips `<script>`.
- **Image URLs are filtered**: only URLs obtained from the 上传图文消息内图片
  interface survive. Tencent-domain URLs (`mmbiz.qpic.cn`) are also accepted.
- Chinese text should be sent as literal UTF-8, **not** `\uXXXX` escapes — the
  docs explicitly warn about this. `JSON.stringify` does not escape non-ASCII,
  so the scripts' approach is correct.
- Encode the request body as UTF-8. A mismatch here produces mojibake that the
  API accepts silently, which is why `verify.mjs` checks for CJK characters.

## IP whitelist

The calling machine's public IP must be whitelisted, else every request fails
with `40164`. Per the official
[API IP 白名单 doc](https://developers.weixin.qq.com/doc/oplatform/developers/basic_func/ip_whitelist.html):

- **公众号/服务号** accept specific IPs **and** CIDR ranges (`172.0.0.1/24`),
  multiple entries. The `172.0.0.*` wildcard form is **not** accepted for
  公众号 (mini-programs do accept it). Use CIDR.
- `40164` fires for calls using `AppSecret` **or** `access_token`.
- Effective about **10 minutes** after saving.
- Path: 微信开发者平台 → 我的业务 → 公众号 → 基础信息 → 开发信息.
- A wrong secret is reported as `40125` **before** an IP check, so a bad secret
  masks an unlisted-IP problem.

Rotating carrier IPs (China Mobile `223.104.x.x` and similar) are the usual
cause of recurrence; whitelisting a `/24` around the observed address is the
durable fix. The authoritative egress IP is the one WeChat names in the `40164`
message — IP-lookup services can disagree behind a proxy.

Note `getcallbackip` is unrelated: it returns WeChat's *push* server IPs, not
anything about your caller IP.

## Account eligibility

The draft endpoints require interface permission. **Personal 订阅号 accounts do
not have it**; use the manual paste path for those. A 服务号 or verified 订阅号
with the relevant permission set works normally.
