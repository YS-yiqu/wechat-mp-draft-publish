# wechat-mp-draft-publish · 微信公众号草稿箱发布

把一篇排好版的图文投进微信公众号**草稿箱**的技能与脚本。核心不是调 API，而是绕开平台那些只有踩过才知道的坑。

配套的排版（Markdown → 公众号 HTML）由另一个技能负责，本仓库只管「封面、正文投递、回读校验」这一段。

## 它解决什么

1. **正文图片被静默丢弃**。微信只接受来自「上传图文消息内图片」接口的 URL，本地路径的 `<img>` 进草稿时直接消失——脚本会逐张上传并改写 `src`。
2. **改一次多一条草稿**。`draft/add` 每调一次就多一篇；文本改动用 `draft/update` 就地更新。
3. **编辑器里才暴露的两端对齐坑**。微信正文默认两端对齐，含多个英文词的文献行会被拉开成大段空白，本地 HTML 里看不出来。
4. **IP 白名单反复失败**。出口 IP 会随运营商/重拨变化，单 IP 白名单必然复发，要按运营商网段加。
5. **文档限制与实测限制不一致**。官方文档写的 2KB 正文、32 字标题都不成立，本技能用的是实测值。

## 依赖

- **Node.js ≥ 18**（脚本使用内置 `fetch`，无需 npm 安装任何依赖）
- **Windows**（凭据从 `HKCU\Environment` 注册表读取；其他系统请用进程环境变量）
- 可选：**headless Chrome**（用模板生成 2.35:1 封面）

## 安装

技能是一个目录，**整个目录一起放**（只拷 `SKILL.md` 会让所有脚本失效）：

```
<skills 根>/wechat-mp-draft-publish/
├── SKILL.md
├── README.md
├── scripts/
├── references/
└── templates/
```

常见技能根：

| 环境 | 目录 |
|---|---|
| DeepSeek Harness | `~/.agents/skills/` 或 `~/.dsh/skills/` |
| Claude Code | `~/.claude/skills/` |

## 凭据

放在用户环境变量里，不要写进脚本或仓库：

```cmd
setx WX_APPID "wx你的AppID"
setx WX_SECRET "你的AppSecret"
```

脚本读取顺序：当前进程环境 → `HKCU\Environment` 注册表（已运行的终端不用重启）。

## 用法

```powershell
# 0) 白名单：出口 IP 要加进 公众号 → 基础信息 → 开发信息 → API IP 白名单
#    建议填运营商网段（如 223.104.0.0/13），别填单个 IP

# 1) 正文内的图片换成微信托管地址（生成发布用正文）
node scripts/prepare-publish-body.mjs body.html body-publish.html

# 2) 首次投递草稿
node scripts/publish.mjs --title "标题" --digest "摘要" --cover cover.png --content body-publish.html

# 3) 回读校验（必做，media_id 只代表请求被接受）
node scripts/verify.mjs <media_id>

# 4) 后续修改就地更新，不要再跑 publish.mjs
node scripts/update-draft.mjs --media-id <id> --title "标题" --thumb <封面 media_id> `
  --content body-publish.html --digest "摘要"

# 排查：列出草稿箱里的草稿
node scripts/account-status.mjs
```

## 目录

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 技能正文：平台限制实测表、两条路径（API / 手工粘贴）、各步骤与坑 |
| `scripts/publish.mjs` | token → 永久封面上传 → `draft/add`，含出口 IP 自检与 40164 处置 |
| `scripts/prepare-publish-body.mjs` | 正文图 `media/uploadimg` 上传并改写 URL |
| `scripts/update-draft.mjs` | `draft/update` 就地更新草稿 |
| `scripts/verify.mjs` | 回读草稿并跑 10 项断言（含乱码、块级结构、体积） |
| `scripts/account-status.mjs` | 列出全部草稿 + 探测 `freepublish` 权限 |
| `scripts/probe-limits.mjs` | 重新实测平台限制 |
| `scripts/test-40164.mjs`、`scripts/test-structure.mjs` | 回归测试 |
| `templates/` | 900×383 封面模板、正文骨架 |

## 版本节奏

**一个月一版**：期间改动先在本地用，确认一段时间没问题再升版（`1.0.0 → 1.1.0`）。升版时同步 `SKILL.md` 的 `version` 字段并打 `v*` 标签，CI 会自动打包成 Release 附件。

## 许可

MIT，见仓库根目录 `LICENSE`。注意：SkillHub 上传接口不接受 `LICENSE` 文件，商城侧只在元数据里声明 license 字段。
