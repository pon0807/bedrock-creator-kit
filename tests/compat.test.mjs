import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupEnv } from "./helpers.mjs";

const env = setupEnv({ games: { bedrock: "1.26.52", education: "1.26.32", preview: "1.26.70" } });
after(env.cleanup);
const { apiFor, checkManifestOnTarget, versionChoices } = await import("../lib/compat.mjs");

const target = (label, engine) => ({ label, engine, kind: "game" });
const pack = (deps, min = "1.26.30") => ({ name: "TestBP", manifest: { header: { uuid: "x", version: "1.0.0", min_engine_version: min }, dependencies: deps } });

test("ゲームの版から、使える Script API の版を割り出す（npm の記録から）", () => {
  assert.deepEqual(apiFor("@minecraft/server", [1, 26, 32]), { stable: "2.8.0", beta: "2.9.0", betaEngine: "1.26.32", exact: true });
  assert.equal(apiFor("@minecraft/server", [1, 26, 52]).stable, "2.10.0");
  assert.equal(apiFor("@minecraft/server", [1, 26, 52]).beta, "2.11.0");
  // Preview は rc の版を stable とみなす
  assert.equal(apiFor("@minecraft/server", [1, 26, 70]).stable, "2.12.0");
  assert.equal(apiFor("@minecraft/server-ui", [1, 26, 32]).stable, "2.1.0");
});

test("教育版で動かない版を見つける", () => {
  const edu = target("教育版", [1, 26, 32]);
  const errs = (deps, min) => checkManifestOnTarget(pack(deps, min), edu).filter((x) => x.level === "error");
  assert.equal(errs([{ module_name: "@minecraft/server", version: "2.10.0" }]).length, 1);
  assert.equal(errs([{ module_name: "@minecraft/server", version: "2.8.0" }]).length, 0);
  assert.equal(errs([{ module_name: "@minecraft/server", version: "2.11.0-beta" }]).length, 1);
  assert.equal(errs([{ module_name: "@minecraft/server", version: "2.9.0-beta" }]).length, 0);
  assert.equal(errs([], "1.26.40").length, 1, "min_engine_version が新しすぎる");
});

test("alpha は確かめられないので注意だけ", () => {
  const p = checkManifestOnTarget(pack([{ module_name: "@minecraft/server", version: "3.0.0-alpha" }]), target("Preview", [1, 26, 70]));
  assert.ok(p.some((x) => x.level === "warn"));
  assert.ok(!p.some((x) => x.level === "error"));
});

test("選べる版: 送り先すべてで動く版がおすすめになる", () => {
  const both = [target("統合版", [1, 26, 52]), target("教育版", [1, 26, 32])];
  assert.equal(versionChoices("@minecraft/server", both).recommended, "2.8.0");
  assert.equal(versionChoices("@minecraft/server", [both[0]]).recommended, "2.10.0");
  assert.equal(versionChoices("@minecraft/vanilla-data", both).recommended, "1.26.32");
  assert.ok(versionChoices("@minecraft/server-net", both).options.every((o) => o.value.endsWith("-beta")));
});

test("ゲームの版が 1 つも分からなくても、おすすめの版が決まる", () => {
  const r = versionChoices("@minecraft/server", [target("不明", null)]);
  assert.match(r.recommended ?? "", /^\d+\.\d+\.\d+$/);
});
