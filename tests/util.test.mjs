import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVersion, bump, globToRegExp, parseJsonLoose, cmpNums } from "../lib/util.mjs";

test("版を読む（文字列・配列・beta）", () => {
  assert.deepEqual(parseVersion("1.26.40"), { nums: [1, 26, 40], pre: "" });
  assert.deepEqual(parseVersion([1, 2, 3]), { nums: [1, 2, 3], pre: "" });
  assert.deepEqual(parseVersion("2.9.0-beta"), { nums: [2, 9, 0], pre: "beta" });
  assert.equal(parseVersion("abc"), null);
  assert.ok(cmpNums([1, 26, 32], [1, 26, 40]) < 0);
});

test("版を上げる（形は元のまま）", () => {
  assert.equal(bump("1.0.0", "patch"), "1.0.1");
  assert.equal(bump("1.2.3", "minor"), "1.3.0");
  assert.equal(bump("1.2.3", "major"), "2.0.0");
  assert.deepEqual(bump([1, 0, 9], "patch"), [1, 0, 10]);
});

test("簡易グロブ", () => {
  assert.ok(globToRegExp("**/*.ts").test("scripts/a/b.ts"));
  assert.ok(globToRegExp("**/*.ts").test("main.ts"));
  assert.ok(!globToRegExp("**/*.ts").test("main.js"));
  assert.ok(globToRegExp("**/node_modules/**").test("x/node_modules/y/z.js"));
  assert.ok(globToRegExp("**/package.json").test("package.json"));
});

test("コメントと末尾カンマのある JSON を読む（文字列の中の // は消さない）", () => {
  const j = parseJsonLoose('{\n // コメント\n "url": "https://example.com", /* 囲み */\n "a": [1, 2,],\n}');
  assert.deepEqual(j, { url: "https://example.com", a: [1, 2] });
});
