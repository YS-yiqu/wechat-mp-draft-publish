/**
 * Test the 40164 (IP-not-whitelisted) handling branch.
 *
 * This branch is otherwise untestable: it only fires when the caller IP is
 * NOT whitelisted, which is exactly the condition we cannot reproduce on a
 * correctly configured account. So the handler is exported and driven here
 * with a real WeChat error string captured earlier.
 *
 * Run: node test-40164.mjs
 */
import { handleNotWhitelisted } from './publish.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

function capture(errmsg) {
  const lines = [];
  const code = handleNotWhitelisted(errmsg, (...a) => lines.push(a.join(' ')));
  return { code, text: lines.join('\n') };
}

console.log('=== 40164 分支测试 ===\n');

// A representative error string: an address inside the China Mobile /13 (not
// this machine's own address — fixtures stay non-identifying).
const REAL = 'invalid ip 223.104.10.20 ipv6 ::ffff:223.104.10.20, not in whitelist rid: 6aa8b75c-46869c25-5d042459';
{
  const { code, text } = capture(REAL);
  check('退出码为 2（可供调用方识别"需加白名单"）', code === 2, `got ${code}`);
  check('提取出 IPv4 地址 223.104.10.20', text.includes('223.104.10.20'));
  check('未把 IPv6 前缀误当 IP', !text.includes('👉 微信看到的出口 IP 是：::ffff'));
  check('识别出运营商为 中国移动', text.includes('中国移动'));
  check('给出了 /24 IP 段建议', text.includes('223.104.10.0/24'));
  check('给出白名单链接（有 AppID → 账号专属链接，无 → 通用入口）',
    (text.includes('/console/product/mp/wx') &&
      text.includes('tab1=basicInfo') && text.includes('tab2=dev')) ||
    text.includes('developers.weixin.qq.com/platform'));
  check('链接不含会话 token（可安全打印）', !/token=/.test(text));
  check('提示不要相信 IP 查询网站', text.includes('不要相信 IP 查询网站'));
}

// Degenerate input: no IP present at all -> must not crash, must still advise.
{
  const { code, text } = capture('not in whitelist');
  check('无 IP 时不崩溃，仍返回 2', code === 2);
  check('无 IP 时回退到打印原始报错', text.includes('not in whitelist'));
}

// Empty / undefined errmsg
{
  const { code } = capture(undefined);
  check('errmsg 为 undefined 时不崩溃', code === 2);
}

// Another carrier's address: correctly labelled, and a /24 is still the right
// tightest suggestion. (An earlier version of this test wrongly asserted that
// unknown allocations get NO range — but a /24 around the observed address is
// always actionable, and `allocation` only adds a wider fallback on top.)
{
  const { text } = capture('invalid ip 112.90.1.5, not in whitelist');
  check('联通 IP 识别为 中国联通', text.includes('中国联通'));
  check('仍然给出该 /24 段建议', text.includes('112.90.1.0/24'));
}

/* ------------------------------------------------------------------ *
 * Regression: an egress address from a Beijing Unicom /12 (123.112.0.0/12,
 * APNIC handle UNICOM-BJ). It first printed "未知运营商" because the carrier
 * table only understood 223.104.x.x; fixed by adding that RDAP-verified
 * allocation. Fixture address is inside the /12, not this machine's.
 * ------------------------------------------------------------------ */
{
  const REAL_V2 = 'invalid ip 123.119.5.6 ipv6 ::ffff:123.119.5.6, not in whitelist rid: x';
  const { code, text } = capture(REAL_V2);
  check('[回归] 退出码为 2', code === 2, `got ${code}`);
  check('[回归] 识别为 中国联通（北京），不再是"未知运营商"', text.includes('中国联通（北京）'));
  check('[回归] 不再出现"未知运营商"', !text.includes('未知运营商'));
  check('[回归] 建议 /24 段 123.119.5.0/24', text.includes('123.119.5.0/24'));
  check('[回归] 提供更大的 /12 兜底段', text.includes('123.112.0.0/12'));
}

// Wider China Mobile allocation (223.104.0.0/13) should also be recognised.
{
  const { text } = capture('invalid ip 223.108.5.9, not in whitelist');
  check('223.108.x.x 归为中国移动（/13 覆盖）', text.includes('中国移动'));
  check('给出该 /24 建议', text.includes('223.108.5.0/24'));
}

// IPv6 in the error must not crash the handler, and must not have IPv6 hex
// fragments mistaken for an IPv4 address.
{
  const { code, text } = capture('invalid ip 2408:8207:5458::1, not in whitelist');
  check('IPv6 报错不崩溃、仍返回 2', code === 2);
  check('不把 IPv6 当作 IPv4 输出', !text.includes('2408.8207'), );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
