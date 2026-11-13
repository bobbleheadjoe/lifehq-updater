// LifeHQ Updater engine: decides, file by file, how to bring a customer's vault
// from the LifeHQ release they're on to a new one without losing their changes.
// Pure logic (no Obsidian APIs) so it can be unit-tested in node.

export interface HistoryVersion { version: string; date: string; files: Record<string, string>; }
export interface History {
  schema: number;
  versions: HistoryVersion[];
  blobs: Record<string, string>;
  /** Mike's explanations: version -> settings file -> setting key (dot path, or "*" for the whole file) -> why */
  reasons?: Record<string, Record<string, Record<string, string>>>;
}

/** One setting LifeHQ changed between the customer's version and the new one. */
export interface SettingChange {
  key: string;                 // dot path, e.g. "callouts.custom" (for display)
  path: string[];              // the same path as keys (keys may contain dots)
  recommended: boolean;        // pre-checked: the customer still had LifeHQ's old value
  from?: unknown;              // LifeHQ's old value (undefined = new setting)
  to?: unknown;                // LifeHQ's new value (undefined = setting removed)
  added?: unknown[];           // for lists: entries LifeHQ added
  removed?: unknown[];         // for lists: entries LifeHQ removed
  reordered?: boolean;         // list only changed order
  applied: boolean;            // true when the customer's vault now has LifeHQ's change
  yours?: unknown;             // the customer's value, when theirs was kept
  reason?: string;
}

export type ActionKind =
  | "add"            // new in this release
  | "update"         // you never changed it: replaced with the new version
  | "merge"          // settings file you changed: LifeHQ's changes merged in key by key
  | "keep-yours"     // you customized it: yours kept, new version saved for comparison
  | "skip-removed"   // you deleted or renamed it: not brought back
  | "rename"         // LifeHQ renamed/moved it and you never changed it
  | "retire"         // LifeHQ removed it and you never changed it: moved to the update folder
  | "retire-kept"    // LifeHQ removed it but you changed it: left where it is
  | "plugin-update"  // plugin code updated to the release's version
  | "plugin-newer"   // you already have the same or a newer plugin version
  | "plugin-removed" // you uninstalled this plugin: not reinstalled
  | "self";          // the updater updating itself

export interface Action {
  id: string;                  // stable id for the checklist
  kind: ActionKind;
  recommended: boolean;        // pre-checked in the checklist
  path: string;
  files?: [string, Uint8Array][]; // plugin actions: every file to write for that plugin
  userJson?: unknown;          // settings files: the customer's current settings
  theirsJson?: unknown;        // settings files: the new release's settings
  to?: string;                 // rename/retire destination
  data?: Uint8Array;           // bytes to write (add/update/merge/plugin-update/self/rename content)
  newVersion?: Uint8Array;     // release bytes saved for comparison (keep-yours/skip-removed/retire-kept)
  conflicts?: string[];        // settings where your value was kept over a LifeHQ change
  note?: string;
  label?: string;              // friendly name, e.g. "Callout Manager settings"
  settings?: SettingChange[];  // every setting LifeHQ changed in this file
  selected?: boolean;          // set when applied: what the customer chose
}

export interface Plan {
  from: string;
  fromDetected: boolean;       // true when the starting version was inferred from file fingerprints
  to: string;
  actions: Action[];
  unchanged: number;
  warnings: string[];
  versions: string[];          // every LifeHQ release, newest first (for "change starting version")
}

export interface VaultReader {
  read(path: string): Promise<Uint8Array | null>; // null when the file doesn't exist
  pluginDirExists(id: string): Promise<boolean>;
  findByName(name: string): Promise<string[]>;  // vault paths of notes/files with this file name

}

export const SELF_ID = "lifehq-updater";
const SELF_DIR = `.obsidian/plugins/${SELF_ID}/`;
const PLUGIN_RE = /^\.obsidian\/plugins\/([^/]+)\/(.+)$/;
const CODE_FILES = new Set(["main.js", "manifest.json", "styles.css"]);

// Same filter as tools/build_history.py
export function tracked(rel: string): boolean {
  const parts = rel.split("/");
  if (parts[parts.length - 1] === ".DS_Store" || parts.includes("__MACOSX") || parts.includes(".trash")) return false;
  if (rel.startsWith(".obsidian/workspace") || rel.startsWith(SELF_DIR)) return false;
  return true;
}

// ---------- helpers ----------

export async function sha256(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const dec = new TextDecoder();
const enc = new TextEncoder();
export const text = (b: Uint8Array) => dec.decode(b);
export const bytes = (s: string) => enc.encode(s);

function parseJson(s: string | undefined | null): unknown {
  if (s == null) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

export function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEq(x, bb[i]));
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ka = Object.keys(ao), kb = Object.keys(bo);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEq(ao[k], bo[k]));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrimArray = (v: unknown): v is (string | number | boolean)[] => Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null);

/** Three-way merge of JSON settings. `base` = what LifeHQ shipped in the customer's
 *  version, `user` = what's in their vault now, `theirs` = the new release.
 *  LifeHQ's change wins only where the customer still has LifeHQ's old value. */
export function merge3(base: unknown, user: unknown, theirs: unknown, path = "", conflicts: string[] = []): unknown {
  if (deepEq(user, theirs)) return user;
  if (deepEq(base, theirs)) return user;      // LifeHQ didn't change this
  if (base !== undefined && deepEq(base, user)) return theirs; // you didn't change this
  if (isObj(user) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(user)) {
      const p = path ? `${path}.${k}` : k;
      if (k in theirs) out[k] = merge3(b[k], user[k], theirs[k], p, conflicts);
      else if (k in b && deepEq(b[k], user[k])) continue; // LifeHQ removed it and you never changed it
      else out[k] = user[k];
    }
    for (const k of Object.keys(theirs)) {
      if (k in user) continue;
      const p = path ? `${path}.${k}` : k;
      if (!(k in b)) out[k] = theirs[k];                // new setting
      else if (!deepEq(b[k], theirs[k])) conflicts.push(p); // you removed it, LifeHQ changed it: yours wins
    }
    return out;
  }
  if (isPrimArray(user) && isPrimArray(theirs) && (base === undefined || isPrimArray(base))) {
    // Lists like enabled plugins: keep yours, add what LifeHQ added, drop what LifeHQ dropped.
    const b = (base as (string | number | boolean)[] | undefined) ?? [];
    const added = theirs.filter((x) => !b.includes(x) && !user.includes(x));
    const dropped = b.filter((x) => !theirs.includes(x));
    return [...user.filter((x) => !dropped.includes(x)), ...added];
  }
  conflicts.push(path || "(whole file)");
  return user;
}

/** Every setting that differs between two versions of a settings file.
 *  Objects are walked key by key; lists are compared entry by entry. */
export function settingDiff(base: unknown, theirs: unknown, path: string[] = [], out: (Omit<SettingChange, "applied" | "key" | "recommended"> & { path: string[] })[] = []) {
  if (deepEq(base, theirs)) return out;
  if (isObj(base) && isObj(theirs)) {
    for (const k of new Set([...Object.keys(base), ...Object.keys(theirs)])) settingDiff(base[k], theirs[k], [...path, k], out);
    return out;
  }
  if (Array.isArray(base) && Array.isArray(theirs)) {
    const added = theirs.filter((x) => !base.some((y) => deepEq(x, y)));
    const removed = base.filter((x) => !theirs.some((y) => deepEq(x, y)));
    out.push({ path, from: base, to: theirs, added, removed, reordered: !added.length && !removed.length });
    return out;
  }
  out.push({ path, from: base, to: theirs });
  return out;
}

function getAt(o: unknown, path: string[]): unknown {
  let cur = o;
  for (const k of path) { if (!isObj(cur) || !(k in cur)) return undefined; cur = cur[k]; }
  return cur;
}

/** Describe each LifeHQ setting change and whether it landed in the customer's vault. */
export function describeSettings(base: unknown, theirs: unknown, user: unknown, final: unknown,
  reasonFor: (key: string) => string | undefined): SettingChange[] {
  return settingDiff(base, theirs).map((d) => {
    const key = d.path.join(".");
    const fv = getAt(final, d.path);
    let applied: boolean;
    if (d.added || d.removed) {
      const has = (x: unknown) => Array.isArray(fv) && fv.some((y) => deepEq(x, y));
      applied = d.reordered ? deepEq(fv, d.to) : (d.added!.every(has) && !d.removed!.some(has));
    } else {
      applied = deepEq(fv, d.to);
    }
    const c: SettingChange = { key, path: d.path, recommended: applied, applied, reason: reasonFor(key) };
    if (d.added || d.removed) { c.added = d.added; c.removed = d.removed; c.reordered = d.reordered; if (d.reordered) { c.from = d.from; c.to = d.to; } }
    else { c.from = d.from; c.to = d.to; }
    if (!applied) c.yours = getAt(user, d.path);
    return c;
  });
}

function setAt(o: Record<string, unknown>, path: string[], v: unknown) {
  let cur = o;
  for (const k of path.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (v === undefined) delete cur[last]; else cur[last] = v;
}

/** Build a settings file from the customer's settings plus only the LifeHQ changes they checked.
 *  Simple lists (like enabled plugins or callout names) get LifeHQ's additions/removals while
 *  keeping the customer's own entries; anything else takes LifeHQ's value as a whole. */
export function applySettingSelection(user: unknown, theirs: unknown, changes: SettingChange[], selected: (c: SettingChange) => boolean): unknown {
  const out = (isObj(user) ? JSON.parse(JSON.stringify(user)) : {}) as Record<string, unknown>;
  for (const c of changes) {
    if (!selected(c)) continue;
    const lists = (c.added || c.removed) && !c.reordered && [...(c.added ?? []), ...(c.removed ?? [])].every((x) => typeof x !== "object" || x === null);
    const cur = getAt(out, c.path);
    if (lists && Array.isArray(cur)) {
      const next = cur.filter((x) => !(c.removed ?? []).some((y) => deepEq(x, y)));
      for (const x of c.added ?? []) if (!next.some((y) => deepEq(x, y))) next.push(x);
      setAt(out, c.path, next);
    } else {
      setAt(out, c.path, JSON.parse(JSON.stringify(getAt(theirs, c.path) ?? null)) ?? undefined);
      if (getAt(theirs, c.path) === undefined) setAt(out, c.path, undefined);
    }
  }
  return out;
}

const CORE_LABELS: Record<string, string> = {
  "app.json": "Obsidian settings (Editor, Files and links)",
  "appearance.json": "Obsidian appearance",
  "core-plugins.json": "Obsidian core plugins",
  "community-plugins.json": "Enabled community plugins",
  "hotkeys.json": "Hotkeys",
  "daily-notes.json": "Daily notes (core plugin)",
  "templates.json": "Templates (core plugin)",
  "types.json": "Property types",
  "graph.json": "Graph view",
};

function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// ---------- planning ----------

export async function planUpdate(
  history: History,
  release: Map<string, Uint8Array>,   // every file in the new release, vault-relative
  vault: VaultReader,
  installedVersion: string | null,
  selfVersion: string,
): Promise<Plan> {
  const warnings: string[] = [];
  const target = history.versions[history.versions.length - 1];
  const relHash = new Map<string, string>();
  for (const [p, b] of release) relHash.set(p, await sha256(b));

  const tracked_ = [...release.keys()].filter(tracked);
  const mismatch = tracked_.filter((p) => target.files[p] !== relHash.get(p)).length;
  if (mismatch) warnings.push(`${mismatch} files in this release don't match LifeHQ ${target.version}'s fingerprints.`);

  // Every path LifeHQ ever shipped, and every hash each path ever had.
  const shipped = new Map<string, Set<string>>();
  for (const v of history.versions) for (const [p, h] of Object.entries(v.files)) {
    if (!shipped.has(p)) shipped.set(p, new Set());
    shipped.get(p)!.add(h);
  }
  for (const p of tracked_) if (!shipped.has(p)) shipped.set(p, new Set());

  // Read the customer's copy of every path that matters.
  const userBytes = new Map<string, Uint8Array>();
  const userHash = new Map<string, string>();
  for (const p of shipped.keys()) {
    const b = await vault.read(p);
    if (b) { userBytes.set(p, b); userHash.set(p, await sha256(b)); }
  }

  // Which release are they on?
  let base = history.versions.find((v) => v.version === installedVersion);
  const fromDetected = !base;
  if (!base) {
    let best = -1;
    for (const v of history.versions) {
      let score = 0;
      for (const [p, h] of Object.entries(v.files)) if (userHash.get(p) === h) score++;
      if (score >= best) { best = score; base = v; } // ties go to the newer release
    }
  }
  const baseFiles = base!.files;

  const jsonCache = new Map<string, unknown>();
  const blobJson = (h: string | undefined) => {
    if (!h) return undefined;
    if (!jsonCache.has(h)) jsonCache.set(h, parseJson(history.blobs[h]));
    return jsonCache.get(h);
  };
  const pristine = (p: string): boolean => {
    const h = userHash.get(p);
    if (!h) return false;
    if (shipped.get(p)?.has(h)) return true;
    if (p.endsWith(".json")) { // same settings, different formatting
      const u = parseJson(text(userBytes.get(p)!));
      if (u === undefined) return false;
      for (const sh of shipped.get(p) ?? []) if (deepEq(u, blobJson(sh))) return true;
    }
    return false;
  };

  // Plugins: compare installed vs release versions once per plugin.
  const pluginInfo = new Map<string, { userVer: string | null; relVer: string | null; inBase: boolean; userHas: boolean }>();
  const versionOf = (b: Uint8Array | null | undefined) => (parseJson(b ? text(b) : null) as { version?: string } | undefined)?.version ?? null;
  for (const p of tracked_) {
    const m = PLUGIN_RE.exec(p);
    if (!m || pluginInfo.has(m[1])) continue;
    const id = m[1];
    const manifest = `.obsidian/plugins/${id}/manifest.json`;
    pluginInfo.set(id, {
      userVer: versionOf(userBytes.get(manifest)),
      relVer: versionOf(release.get(manifest)),
      inBase: Object.keys(baseFiles).some((f) => f.startsWith(`.obsidian/plugins/${id}/`)),
      userHas: await vault.pluginDirExists(id),
    });
  }

  const actions: Action[] = [];
  let unchanged = 0;
  const reported = new Set<string>();
  const handledTargets = new Set<string>();

  const RECOMMENDED: Record<ActionKind, boolean> = {
    "add": true, "update": true, "merge": true, "rename": true, "retire": true, "plugin-update": true, "self": true,
    "keep-yours": false, "skip-removed": false, "retire-kept": false, "plugin-newer": false, "plugin-removed": false,
  };
  const push = (a: Omit<Action, "id" | "recommended">) => actions.push({ id: `${a.kind}:${a.path}`, recommended: RECOMMENDED[a.kind], ...a });
  const pluginFiles = (id: string, codeOnly: boolean): [string, Uint8Array][] =>
    tracked_.filter((p) => p.startsWith(`.obsidian/plugins/${id}/`) && (!codeOnly || CODE_FILES.has(p.slice(p.lastIndexOf("/") + 1)))).map((p) => [p, release.get(p)!]);

  // 1. Files LifeHQ removed or renamed since the customer's version.
  for (const p of Object.keys(baseFiles)) {
    if (release.has(p) || !userHash.has(p)) continue;
    const candidates = tracked_.filter((q) => !(q in baseFiles) && !userHash.has(q) &&
      (relHash.get(q) === baseFiles[p] || basename(q) === basename(p)));
    const q = candidates.length === 1 ? candidates[0] : undefined;
    if (q && pristine(p)) {
      const sameContent = relHash.get(q) === userHash.get(p);
      push({ kind: "rename", path: p, to: q, data: sameContent ? undefined : release.get(q) });
      handledTargets.add(q);
    } else if (q) {
      push({ kind: "retire-kept", path: p, to: q, data: release.get(q), newVersion: release.get(q), note: `LifeHQ renamed this to ${q}. Your customized copy stays where it is.` });
      handledTargets.add(q);
    } else if (pristine(p)) {
      push({ kind: "retire", path: p });
    } else {
      push({ kind: "retire-kept", path: p, note: "LifeHQ no longer includes this file. You changed it, so it stays." });
    }
  }

  // 2. Every file in the new release.
  const pluginUpdates = new Map<string, [string, Uint8Array][]>();
  for (const p of tracked_) {
    if (handledTargets.has(p)) continue;
    const rh = relHash.get(p)!;
    const m = PLUGIN_RE.exec(p);
    if (m) {
      const info = pluginInfo.get(m[1])!;
      if (!info.userHas && info.inBase) {
        if (!reported.has(m[1])) {
          push({ kind: "plugin-removed", path: `.obsidian/plugins/${m[1]}/`, files: pluginFiles(m[1], false), note: info.relVer ? `LifeHQ ships ${info.relVer}` : undefined });
          reported.add(m[1]);
        }
        continue;
      }
      if (CODE_FILES.has(m[2]) && info.userHas) {
        if (info.userVer && info.relVer && cmpVersion(info.userVer, info.relVer) >= 0 && userHash.get(p) !== rh) {
          if (!reported.has(m[1])) {
            push({ kind: "plugin-newer", path: `.obsidian/plugins/${m[1]}/`, files: pluginFiles(m[1], true), note: `You have ${info.userVer}; LifeHQ ships ${info.relVer}.` });
            reported.add(m[1]);
          }
          continue;
        }
        if (userHash.get(p) === rh) { unchanged++; continue; }
        if (!pluginUpdates.has(m[1])) pluginUpdates.set(m[1], []);
        pluginUpdates.get(m[1])!.push([p, release.get(p)!]);
        continue;
      }
    }
    const uh = userHash.get(p);
    if (!uh) {
      if (p in baseFiles) {
        const changed = baseFiles[p] !== rh;
        // Did they move it? Look for one file with the same name somewhere else in their vault.
        const moved = p.startsWith(".obsidian/") ? [] : (await vault.findByName(basename(p))).filter((q) => q !== p && !shipped.has(q));
        if (moved.length === 1) {
          const q = moved[0];
          const qb = await vault.read(q);
          const qh = qb ? await sha256(qb) : "";
          if (qh === rh || !changed) { unchanged++; continue; }
          if (shipped.get(p)?.has(qh)) {
            push({ kind: "update", path: q, data: release.get(p), note: `you moved this from ${p}` });
          } else {
            push({ kind: "keep-yours", path: q, data: release.get(p), newVersion: release.get(p), note: `you moved this from ${p}` });
          }
          continue;
        }
        push({ kind: "skip-removed", path: p, data: release.get(p), newVersion: changed ? release.get(p) : undefined });
      } else {
        push({ kind: "add", path: p, data: release.get(p) });
      }
      continue;
    }
    if (uh === rh) { unchanged++; continue; }
    if (pristine(p)) { push({ kind: "update", path: p, data: release.get(p) }); continue; }
    if (p.endsWith(".json")) {
      const u = parseJson(text(userBytes.get(p)!));
      const t = parseJson(text(release.get(p)!));
      if (u !== undefined && t !== undefined) {
        const conflicts: string[] = [];
        const merged = merge3(blobJson(baseFiles[p]), u, t, "", conflicts);
        if (deepEq(merged, u)) {
          if (conflicts.length) push({ kind: "keep-yours", path: p, conflicts, data: release.get(p), newVersion: release.get(p) });
          else unchanged++;
        } else {
          push({ kind: "merge", path: p, data: bytes(JSON.stringify(merged, null, 2)), conflicts });
        }
        continue;
      }
    }
    // A customized file LifeHQ didn't change since their version needs nothing.
    if (baseFiles[p] === rh) { unchanged++; continue; }
    push({ kind: "keep-yours", path: p, data: release.get(p), newVersion: release.get(p) });
  }
  for (const [id, files] of pluginUpdates) {
    const info = pluginInfo.get(id)!;
    push({ kind: "plugin-update", path: `.obsidian/plugins/${id}/`, files, note: info.relVer ? `${info.userVer ?? "?"} → ${info.relVer}` : undefined });
  }

  // 2b. Friendly names, and a setting-by-setting breakdown for every settings file LifeHQ changed.
  const pluginName = (id: string) => {
    const man = `.obsidian/plugins/${id}/manifest.json`;
    const m = (parseJson(text(release.get(man) ?? userBytes.get(man) ?? new Uint8Array())) as { name?: string } | undefined);
    return m?.name ?? id;
  };
  const newer = history.versions.slice(history.versions.indexOf(base!) + 1).reverse(); // newest first
  const reasonFor = (file: string) => (key: string): string | undefined => {
    for (const v of newer) {
      const r = history.reasons?.[v.version]?.[file];
      if (!r) continue;
      const parts = key.split(".");
      for (let i = parts.length; i > 0; i--) { const k = parts.slice(0, i).join("."); if (r[k]) return r[k]; }
      if (r["*"]) return r["*"];
    }
    return undefined;
  };
  for (const act of actions) {
    const m = /^\.obsidian\/plugins\/([^/]+)\/(.*)$/.exec(act.path); // also matches plugin folders ("…/calendar/")
    if (m) act.label = m[2] === "data.json" ? `${pluginName(m[1])} settings` : pluginName(m[1]);
    else if (act.path.startsWith(".obsidian/")) act.label = CORE_LABELS[act.path.slice(10)];
    if (!act.path.startsWith(".obsidian/") || !act.path.endsWith(".json") || !["update", "merge", "keep-yours"].includes(act.kind)) continue;
    const b = blobJson(baseFiles[act.path]);
    const t = parseJson(text(release.get(act.path)!));
    const u = parseJson(text(userBytes.get(act.path)!));
    if (b === undefined || t === undefined) continue;
    const final = act.kind === "update" ? t : act.kind === "merge" ? parseJson(text(act.data!)) : u;
    act.settings = describeSettings(b, t, u, final, reasonFor(act.path));
    act.userJson = u;
    act.theirsJson = t;
  }

  // 3. The updater itself.
  const selfManifest = release.get(`${SELF_DIR}manifest.json`);
  const relSelf = versionOf(selfManifest);
  if (relSelf && cmpVersion(relSelf, selfVersion) > 0) {
    for (const [p, b] of release) if (p.startsWith(SELF_DIR) && !p.endsWith("data.json")) push({ kind: "self", path: p, data: b });
  } else {
    // Same updater version: still take the newer fingerprint history.
    const relHist = release.get(`${SELF_DIR}history.json`);
    const cur = await vault.read(`${SELF_DIR}history.json`);
    if (relHist && (!cur || (await sha256(cur)) !== (await sha256(relHist)))) push({ kind: "self", path: `${SELF_DIR}history.json`, data: relHist });
  }

  return { from: base!.version, fromDetected, to: target.version, actions, unchanged, warnings, versions: history.versions.map((v) => v.version).reverse() };
}
