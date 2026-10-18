/**
 * Inline markdown and maths splitting: code spans are never formatted.
 *
 *   node --experimental-strip-types tests/markdown.test.ts
 */
import assert from "node:assert/strict";
import { inline } from "../src/lib/markdown.ts";
import { splitMath } from "../src/lib/math.ts";

/* the bug: an asterisk inside a code span paired with a later *word* */
const bug = inline("learned by `M* = argmin_M L(M(K); V)` (Eq. 6), all updated by the *same* rank-1 rule");
assert.match(bug, /<code>M\* = argmin_M L\(M\(K\); V\)<\/code>/, "the code span is left exactly as written");
assert.match(bug, /by the <em>same<\/em> rank-1/, "and the real emphasis still works");
assert.equal((bug.match(/<em>/g) ?? []).length, 1, "only one italic run");

assert.equal(inline("`**not bold**` and **bold**"), "<code>**not bold**</code> and <strong>bold</strong>");
assert.equal(inline("`[x](https://a.b)`"), "<code>[x](https://a.b)</code>", "no links inside code");
assert.equal(inline("`<b>` & *it*"), "<code>&lt;b&gt;</code> &amp; <em>it</em>", "escaped once, inside and out");
assert.equal(inline("``a ` b``"), "<code>a ` b</code>", "double-backtick spans hold a backtick");
assert.equal(inline("a * b * c"), "a * b * c", "spaced asterisks are multiplication, not emphasis");
assert.equal(inline("*(Eq. 6)*"), "<em>(Eq. 6)</em>");
assert.equal(inline("an `unclosed span with *it*"), "an `unclosed span with <em>it</em>");
assert.match(inline("[paper](https://arxiv.org/abs/1)"), /<a href="https:\/\/arxiv.org\/abs\/1"/);

/* maths is found outside code spans only */
const kinds = (src: string) => splitMath(src).map((p) => (p.type === "math" ? `M:${p.tex}` : `T:${p.text}`));
assert.deepEqual(kinds("run `echo $HOME and $PATH` then $x^2$"), ["T:run `echo $HOME and $PATH` then ", "M:x^2"]);
assert.deepEqual(kinds("``a $b$ c`` $$\\sigma_t$$"), ["T:``a $b$ c`` ", "M:\\sigma_t"]);
assert.deepEqual(kinds("price `5 and $x$"), ["T:price `5 and ", "M:x"], "a lone backtick does not hide what follows");

console.log("markdown checks passed");
