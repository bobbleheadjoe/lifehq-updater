// Unit tests for the settings merge (run: npm test)
import assert from "node:assert/strict";
import { merge3 } from "./engine.mjs";

const t = (name, fn) => { try { fn(); console.log("ok  ", name); } catch (e) { console.log("FAIL", name, "\n", e.message); process.exitCode = 1; } };

t("LifeHQ change applied when you kept the old value", () => {
  const c = [];
  assert.deepEqual(merge3({ folder: "Files", a: 1 }, { folder: "Files", a: 2 }, { folder: "Media", a: 1 }, "", c), { folder: "Media", a: 2 });
  assert.deepEqual(c, []);
});
t("your value wins over a LifeHQ change, and is reported", () => {
  const c = [];
  assert.deepEqual(merge3({ folder: "Files" }, { folder: "Attachments" }, { folder: "Media" }, "", c), { folder: "Attachments" });
  assert.deepEqual(c, ["folder"]);
});
t("new LifeHQ settings are added, your extra settings kept", () => {
  assert.deepEqual(merge3({ a: 1 }, { a: 1, mine: true }, { a: 1, added: 5 }), { a: 1, mine: true, added: 5 });
});
t("setting LifeHQ removed is dropped only if you never changed it", () => {
  assert.deepEqual(merge3({ a: 1, old: 1 }, { a: 1, old: 1 }, { a: 1 }), { a: 1 });
  assert.deepEqual(merge3({ a: 1, old: 1 }, { a: 1, old: 2 }, { a: 1 }), { a: 1, old: 2 });
});
t("enabled-plugins list: keeps yours, adds LifeHQ's new one, drops LifeHQ's retired one", () => {
  assert.deepEqual(merge3(["dataview", "old-plugin"], ["dataview", "old-plugin", "my-plugin"], ["dataview", "new-plugin"]), ["dataview", "my-plugin", "new-plugin"]);
});
t("nested settings merge per key", () => {
  const c = [];
  const r = merge3({ s: { x: 1, y: 1 } }, { s: { x: 9, y: 1 } }, { s: { x: 1, y: 2 } }, "", c);
  assert.deepEqual(r, { s: { x: 9, y: 2 } });
  assert.deepEqual(c, []);
});
t("arrays of objects are all-or-nothing (QuickAdd choices)", () => {
  const c = [];
  const base = { choices: [{ id: 1 }] };
  assert.deepEqual(merge3(base, { choices: [{ id: 1 }, { id: "mine" }] }, { choices: [{ id: 2 }] }, "", c), { choices: [{ id: 1 }, { id: "mine" }] });
  assert.deepEqual(c, ["choices"]);
  assert.deepEqual(merge3(base, base, { choices: [{ id: 2 }] }), { choices: [{ id: 2 }] });
});
t("no base (file you created yourself): only adds new keys", () => {
  const c = [];
  assert.deepEqual(merge3(undefined, { a: 1 }, { a: 2, b: 3 }, "", c), { a: 1, b: 3 });
  assert.deepEqual(c, ["a"]);
});

import { describeSettings } from "./engine.mjs";
t("every changed setting is described, with what happened in your vault", () => {
  const base = { a: "Files", b: 1, list: ["x", "y"], rules: [{ f: "Maps" }] };
  const theirs = { a: "Media", b: 1, list: ["y", "x", "z"], rules: [{ f: "Deep Dives" }], fresh: true };
  const user = { a: "Mine", b: 1, list: ["x", "y", "me"], rules: [{ f: "Maps" }] };
  const final = { a: "Mine", b: 1, list: ["x", "y", "me", "z"], rules: [{ f: "Deep Dives" }], fresh: true };
  const why = (k) => ({ a: "Attachments live in Media now" })[k];
  const d = Object.fromEntries(describeSettings(base, theirs, user, final, why).map((c) => [c.key, c]));
  assert.deepEqual(Object.keys(d).sort(), ["a", "fresh", "list", "rules"]);
  assert.equal(d.a.applied, false); assert.equal(d.a.yours, "Mine"); assert.equal(d.a.reason, "Attachments live in Media now");
  assert.deepEqual(d.list.added, ["z"]); assert.equal(d.list.applied, true);
  assert.deepEqual(d.rules.added, [{ f: "Deep Dives" }]); assert.deepEqual(d.rules.removed, [{ f: "Maps" }]); assert.equal(d.rules.applied, true);
  assert.equal(d.fresh.from, undefined); assert.equal(d.fresh.applied, true);
});

import { applySettingSelection } from "./engine.mjs";
t("checklist with recommended picks gives the same settings as the automatic merge", () => {
  const cases = [
    [{ folder: "Files", a: 1 }, { folder: "Files", a: 2 }, { folder: "Media", a: 1 }],
    [{ list: ["x", "y"] }, { list: ["x", "y", "me"] }, { list: ["y", "z"] }],
    [{ a: 1, old: 1 }, { a: 1, old: 1 }, { a: 1, fresh: { deep: true } }],
    [{ s: { x: 1, y: 1 } }, { s: { x: 9, y: 1 } }, { s: { x: 1, y: 2 } }],
    [{ rules: [{ f: "Maps" }] }, { rules: [{ f: "Maps" }] }, { rules: [{ f: "Deep Dives" }] }],
  ];
  for (const [base, user, theirs] of cases) {
    const merged = merge3(base, user, theirs);
    const changes = describeSettings(base, theirs, user, merged, () => undefined);
    assert.deepEqual(applySettingSelection(user, theirs, changes, (c) => c.recommended), merged);
  }
});
t("checking a ✋ setting takes LifeHQ's value; unchecking a recommended one keeps yours", () => {
  const base = { folder: "Files", cover: "Files/Covers" }, user = { folder: "Attachments", cover: "Files/Covers" }, theirs = { folder: "Media", cover: "Media/Covers" };
  const changes = describeSettings(base, theirs, user, merge3(base, user, theirs), () => undefined);
  const flip = applySettingSelection(user, theirs, changes, (c) => !c.recommended);
  assert.deepEqual(flip, { folder: "Media", cover: "Files/Covers" });
});
