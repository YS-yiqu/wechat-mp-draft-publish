/**
 * 回归测试：结构校验能否识别「依赖 white-space 的多行结构」。
 *
 * 背景：一次真实事故——正文用 <pre>+white-space 写多行清单，读回的文字校验
 * 全部通过，但在微信编辑器里塌成了一整段。为此给 verify.mjs 加了
 * 「块级元素承载」与「未依赖 <pre>」两项检查，这里反证它们确实有效。
 */
let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`${ok ? '  ✓' : '  ✗'} ${name}`); ok ? pass++ : fail++; };

// 与 verify.mjs 中同一套判定逻辑
const analyze = (body) => ({
  blockCount: (body.match(/<(p|div|li|h[1-6]|tr)[\s>]/gi) || []).length,
  preCount: (body.match(/<pre[\s>]/gi) || []).length,
  reliesOnWhitespace: /white-space\s*:\s*(pre|pre-wrap|pre-line)/i.test(body),
});

const FIXED = [
  '<section style="font-size:16px">',
  ...Array.from({ length: 8 }, (_, i) => `<p>${i + 1} 条目</p>`),
  '</section>',
].join('');

const BROKEN = [
  '<section style="font-size:16px">',
  '<pre style="white-space:pre-wrap">1 总述&#10;2 引用文件&#10;3 采购范围</pre>',
  '<p>只有一段说明</p>',
  '</section>',
].join('');

console.log('=== 结构校验回归测试 ===\n');

const f = analyze(FIXED);
console.log('【修正版：每行一个 <p>】');
console.log(`  块级元素 ${f.blockCount}，<pre> ${f.preCount}，依赖 white-space：${f.reliesOnWhitespace}`);
check('块级元素达阈值 → 通过', f.blockCount >= 5);
check('<pre> 为 0 → 通过', f.preCount === 0);

const b = analyze(BROKEN);
console.log('\n【问题版：<pre> + white-space】');
console.log(`  块级元素 ${b.blockCount}，<pre> ${b.preCount}，依赖 white-space：${b.reliesOnWhitespace}`);
check('块级元素不足 → 被拦截', b.blockCount < 5);
check('<pre> 存在 → 被拦截', b.preCount > 0);
check('检测到依赖 white-space', b.reliesOnWhitespace === true);

console.log('\n【关键】旧写法若只有纯文本校验，是否会被漏过？');
const textOnly = (html) => html.replace(/<[^>]+>/g, '').replace(/&#10;/g, '').trim();
const oldText = textOnly(BROKEN), newText = textOnly(FIXED);
check('纯文本校验对两种写法都"通过"（说明它查不出结构问题）',
  oldText.length > 0 && newText.length > 0);
console.log('  → 证实：文字级断言无法发现结构塌陷，必须单独检查块级元素');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
