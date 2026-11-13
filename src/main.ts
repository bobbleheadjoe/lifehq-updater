import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl } from "obsidian";
import { unzipSync, zipSync } from "fflate";
import { Action, ActionKind, History, Plan, SELF_ID, SettingChange, VaultReader, applySettingSelection, bytes, deepEq, planUpdate, sha256, text } from "./engine";

const API = "https://lifehq-updates.vercel.app/api";

interface Data { installedVersion: string | null; pendingReport: string | null; token: string | null; email: string | null; lastCheck: number; }
const DEFAULTS: Data = { installedVersion: null, pendingReport: null, token: null, email: null, lastCheck: 0 };

/** What the customer picked: checklist id -> checked. Missing ids use the recommendation. */
export type Selection = Map<string, boolean>;
const settingId = (act: Action, c: SettingChange) => `${act.id}#${c.key}`;

// File/plugin groups in the checklist and the report, in order.
const SECTIONS: { kind: ActionKind[]; title: string; blurb: string; checked: string }[] = [
  { kind: ["plugin-update"], title: "Plugin updates", blurb: "New versions of plugins LifeHQ ships.", checked: "" },
  { kind: ["update"], title: "Files you haven't changed", blurb: "These still match what LifeHQ shipped, so they can safely be replaced with the new version.", checked: "" },
  { kind: ["add"], title: "New in this release", blurb: "Files that are new in LifeHQ.", checked: "" },
  { kind: ["rename"], title: "Moved or renamed", blurb: "LifeHQ moved these. Links to them are updated.", checked: "" },
  { kind: ["retire"], title: "No longer part of LifeHQ", blurb: "You never changed these. Checked ones are moved into this update's folder (nothing is deleted).", checked: "" },
  { kind: ["keep-yours"], title: "Files you customized", blurb: "LifeHQ changed these too. Unchecked keeps yours and saves LifeHQ's version next to the report so you can compare. Checking one replaces yours (your version goes in the backup).", checked: "replaced with LifeHQ's version (yours is in the backup)" },
  { kind: ["retire-kept"], title: "Removed from LifeHQ, but you changed them", blurb: "Unchecked leaves them where they are. Checking one moves it into this update's folder.", checked: "moved into this update's folder" },
  { kind: ["skip-removed"], title: "Files you deleted or renamed", blurb: "Unchecked leaves them gone. Checking one brings LifeHQ's version back.", checked: "brought back" },
  { kind: ["plugin-newer"], title: "Plugins you already updated", blurb: "You have the same or a newer version. Checking one installs LifeHQ's version instead.", checked: "replaced with LifeHQ's version" },
  { kind: ["plugin-removed"], title: "Plugins you uninstalled", blurb: "Unchecked leaves them uninstalled. Checking one reinstalls it.", checked: "reinstalled" },
];
const listed = (a: Action) => a.kind !== "self" && !a.settings?.length;

export default class LifeHQUpdater extends Plugin {
  data: Data = { ...DEFAULTS };

  async onload() {
    this.data = Object.assign({}, DEFAULTS, await this.loadData());
    this.addCommand({ id: "check-for-updates", name: "Check for LifeHQ updates", callback: () => this.checkForUpdates(true) });
    this.addCommand({ id: "sign-out", name: "Sign out of LifeHQ updates", callback: () => this.signOut() });
    this.addSettingTab(new UpdaterSettingTab(this.app, this));
    this.addCommand({
      id: "show-version", name: "Show my LifeHQ version",
      callback: () => new Notice(this.data.installedVersion ? `LifeHQ ${this.data.installedVersion}` : "LifeHQ version not recorded yet. It's detected automatically on your first update."),
    });
    this.app.workspace.onLayoutReady(async () => {
      // Once a day, quietly check for a new release (only when signed in).
      if (this.data.token && Date.now() - this.data.lastCheck > 24 * 3600 * 1000) this.checkForUpdates(false);
      const report = this.data.pendingReport;
      if (!report) return;
      this.data.pendingReport = null;
      await this.saveData(this.data);
      const f = this.app.vault.getAbstractFileByPath(report);
      if (f instanceof TFile) this.app.workspace.getLeaf(true).openFile(f);
    });
  }

  // ---- paths: ".obsidian/" in a release means whatever this vault's config folder is ----
  vp(p: string): string { return p.startsWith(".obsidian/") ? normalizePath(this.app.vault.configDir + "/" + p.slice(10)) : normalizePath(p); }
  isConfig(p: string): boolean { return p.startsWith(".obsidian/"); }

  reader(): VaultReader {
    const a = this.app.vault.adapter;
    return {
      read: async (p) => (await a.exists(this.vp(p))) ? new Uint8Array(await a.readBinary(this.vp(p))) : null,
      pluginDirExists: (id) => a.exists(this.vp(`.obsidian/plugins/${id}`)),
      findByName: async (name) => this.app.vault.getFiles().filter((f) => f.name === name).map((f) => f.path),
    };
  }

  async bundledHistory(): Promise<History | null> {
    const p = normalizePath(`${this.manifest.dir}/history.json`);
    return (await this.app.vault.adapter.exists(p)) ? JSON.parse(await this.app.vault.adapter.read(p)) : null;
  }

  /** Read a release zip (the Blank vault as shipped) into vault-relative paths. */
  readRelease(zip: Uint8Array): Map<string, Uint8Array> {
    const entries = unzipSync(zip);
    const names = Object.keys(entries).filter((n) => !n.endsWith("/") && !n.includes("__MACOSX"));
    const anchor = names.find((n) => n.includes(".obsidian/"));
    if (!anchor) throw new Error("This zip doesn't look like a LifeHQ vault (no .obsidian folder).");
    const root = anchor.slice(0, anchor.indexOf(".obsidian/"));
    const out = new Map<string, Uint8Array>();
    for (const n of names) if (n.startsWith(root) && !n.endsWith(".DS_Store")) out.set(n.slice(root.length), entries[n]);
    return out;
  }

  showChecklist(plan: Plan, replan?: (from: string) => Promise<Plan>) { new ChecklistModal(this.app, this, plan, replan).open(); }

  async planFromZip(zip: Uint8Array, fromVersion?: string): Promise<Plan> {
    const release = this.readRelease(zip);
    const h = release.get(`.obsidian/plugins/${SELF_ID}/history.json`);
    const history: History | null = h ? JSON.parse(text(h)) : await this.bundledHistory();
    if (!history) throw new Error("No LifeHQ version history found in the release or the updater.");
    return planUpdate(history, release, this.reader(), fromVersion ?? this.data.installedVersion, this.manifest.version);
  }

  // ---- checking for updates (only verified LifeHQ owners can download) ----
  async api(path: string, init: { method?: string; body?: unknown } = {}) {
    const r = await requestUrl({
      url: `${API}/${path}`, method: init.method ?? "GET", throw: false,
      headers: { "Content-Type": "application/json", ...(this.data.token ? { Authorization: `Bearer ${this.data.token}` } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    let json: { error?: string; [k: string]: unknown } = {};
    try { json = r.json; } catch { /* binary or empty */ }
    return { status: r.status, json, buffer: r.arrayBuffer };
  }

  async signOut() {
    this.data.token = null; this.data.email = null;
    await this.saveData(this.data);
    new Notice("Signed out of LifeHQ updates.");
  }

  async checkForUpdates(interactive: boolean) {
    if (!this.data.token) {
      if (interactive) new SignInModal(this.app, this, () => this.checkForUpdates(true)).open();
      return;
    }
    try {
      const latest = await this.api("latest");
      this.data.lastCheck = Date.now();
      await this.saveData(this.data);
      if (latest.status === 401) {
        this.data.token = null; await this.saveData(this.data);
        if (interactive) new SignInModal(this.app, this, () => this.checkForUpdates(true)).open();
        return;
      }
      if (latest.status !== 200) { if (interactive) new Notice(latest.json.error ?? `Couldn't check for updates (${latest.status}).`, 10000); return; }
      const version = String(latest.json.version);
      if (version === this.data.installedVersion) {
        if (interactive) new Notice(`You're on the latest LifeHQ (${version}).`);
        return;
      }
      if (!interactive) { new Notice(`LifeHQ ${version} is available. Run "Check for LifeHQ updates" to see what's new.`, 15000); return; }
      new Notice(`Downloading LifeHQ ${version}…`);
      const dl = await this.api("download");
      if (dl.status !== 200) { new Notice(dl.json.error ?? `Download failed (${dl.status}).`, 10000); return; }
      const zip = new Uint8Array(dl.buffer);
      if ((await sha256(zip)) !== latest.json.sha256) { new Notice("The download didn't arrive intact. Please try again.", 10000); return; }
      const plan = await this.planFromZip(zip);
      new ChecklistModal(this.app, this, plan, (v) => this.planFromZip(zip, v)).open();
    } catch (e) {
      if (interactive) new Notice(`Couldn't check for updates: ${(e as Error).message}`, 10000);
    }
  }

  // ---- writing ----
  async ensureFolder(folder: string) {
    if (!folder || folder === "/") return;
    const a = this.app.vault.adapter;
    if (await a.exists(folder)) return;
    await this.ensureFolder(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "");
    try { await a.mkdir(folder); } catch { /* created meanwhile */ }
  }

  async write(p: string, data: Uint8Array) {
    const path = this.vp(p);
    await this.ensureFolder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const f = this.isConfig(p) ? null : this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.vault.modifyBinary(f, buf);
    else await this.app.vault.adapter.writeBinary(path, buf);
  }

  async move(from: string, to: string) {
    const src = this.vp(from), dst = normalizePath(to);
    await this.ensureFolder(dst.includes("/") ? dst.slice(0, dst.lastIndexOf("/")) : "");
    const f = this.isConfig(from) ? null : this.app.vault.getAbstractFileByPath(src);
    if (f instanceof TFile) await this.app.fileManager.renameFile(f, dst); // updates links
    else await this.app.vault.adapter.rename(src, dst);
    await this.removeEmptyParents(src);
  }

  /** After moving a file out, remove folders the move left completely empty (never the vault root). */
  async removeEmptyParents(path: string) {
    const a = this.app.vault.adapter;
    let dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    while (dir && dir !== this.app.vault.configDir) {
      if (!(await a.exists(dir))) break;
      const { files, folders } = await a.list(dir);
      if (files.some((f) => !f.endsWith("/.DS_Store")) || folders.length) break;
      const folder = this.app.vault.getAbstractFileByPath(dir);
      if (folder) await this.app.vault.delete(folder, true); else await a.rmdir(dir, true);
      dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    }
  }

  /** Save LifeHQ's new version of a file the customer kept, without letting it leak into
   *  their task/Dataview queries: notes and settings are wrapped in a code block. */
  async saveForComparison(dir: string, p: string, data: Uint8Array): Promise<string> {
    const shown = p.startsWith(".obsidian/") ? "obsidian-settings/" + p.slice(10) : p;
    if (p.endsWith(".md") || p.endsWith(".json") || p.endsWith(".css")) {
      const body = text(data);
      const longest = Math.max(3, ...(body.match(/`+/g) ?? []).map((s) => s.length));
      const fence = "`".repeat(longest + 1);
      const lang = p.endsWith(".md") ? "markdown" : p.endsWith(".json") ? "json" : "css";
      const out = `${dir}/New versions/${shown.replace(/\.(md|json|css)$/, "")}.md`;
      const note = `LifeHQ's new version of \`${p}\`. It's in a code block so its tasks and queries don't show up elsewhere in your vault. Copy whatever you want into your own version.\n\n${fence}${lang}\n${body}\n${fence}\n`;
      await this.write(out, bytes(note));
      return out;
    }
    const out = `${dir}/New versions/${shown}`;
    await this.write(out, data);
    return out;
  }

  /** Apply the customer's checklist. Records what happened on each action/setting for the report. */
  async applyPlan(plan: Plan, selection: Selection = new Map()): Promise<string> {
    const dir = `LifeHQ Updates/LifeHQ ${plan.to}`;
    const a = this.app.vault.adapter;
    const pick = (id: string, rec: boolean) => selection.has(id) ? selection.get(id)! : rec;

    // 1. Decide every write and move.
    const writes: [string, Uint8Array][] = [];
    const moves: [string, string][] = [];
    const compare: [Action, string, Uint8Array][] = [];
    const removedDir = (p: string) => `${dir}/Removed from LifeHQ/${p.startsWith(".obsidian/") ? "obsidian-settings/" + p.slice(10) : p}`;
    for (const act of plan.actions) {
      if (act.settings?.length) {
        for (const c of act.settings) c.applied = pick(settingId(act, c), c.recommended);
        const chosen = act.settings.filter((c) => c.applied);
        act.selected = chosen.length > 0;
        if (chosen.length) {
          const all = chosen.length === act.settings.length;
          const final = applySettingSelection(act.userJson, act.theirsJson, act.settings, (c) => !!c.applied);
          if (act.kind === "update" && all) writes.push([act.path, act.data!]);
          else if (!deepEq(final, act.userJson)) writes.push([act.path, bytes(JSON.stringify(final, null, 2))]);
        }
        if (act.settings.some((c) => !c.applied) && act.newVersion) compare.push([act, act.path, act.newVersion]);
        continue;
      }
      const on = act.kind === "self" ? true : pick(act.id, act.recommended);
      act.selected = on;
      switch (act.kind) {
        case "add": case "update": case "merge": case "self": case "keep-yours": case "skip-removed":
          if (on && act.data) writes.push([act.path, act.data]);
          else if (!on && act.newVersion) compare.push([act, act.path, act.newVersion]);
          break;
        case "plugin-update": case "plugin-newer": case "plugin-removed":
          if (on) writes.push(...act.files!);
          break;
        case "rename":
          if (on) { moves.push([act.path, act.to!]); if (act.data) writes.push([act.to!, act.data]); }
          break;
        case "retire":
          if (on) moves.push([act.path, removedDir(act.path)]);
          break;
        case "retire-kept":
          if (on) { moves.push([act.path, removedDir(act.path)]); if (act.to && act.data) writes.push([act.to, act.data]); }
          else if (act.newVersion) compare.push([act, act.to ?? act.path, act.newVersion]);
          break;
      }
    }

    // 2. Back up the current version of everything that will be overwritten or moved.
    const backup: Record<string, Uint8Array> = {};
    for (const p of [...writes.map((w) => w[0]), ...moves.map((m) => m[0])]) {
      if (!backup[p] && (await a.exists(this.vp(p)))) backup[p] = new Uint8Array(await a.readBinary(this.vp(p)));
    }
    await this.write(`${dir}/Backup before update.zip`, zipSync(backup, { level: 6 }));

    // A reinstalled plugin must also be switched back on.
    const reinstall = plan.actions.filter((x) => x.kind === "plugin-removed" && x.selected).map((x) => x.path.split("/")[2]);
    if (reinstall.length) {
      const cp = ".obsidian/community-plugins.json";
      const pending = writes.find((w) => w[0] === cp);
      const current = pending ? JSON.parse(text(pending[1])) : JSON.parse((await a.exists(this.vp(cp))) ? await a.read(this.vp(cp)) : "[]");
      const next = [...current, ...reinstall.filter((id) => !current.includes(id))];
      if (pending) pending[1] = bytes(JSON.stringify(next, null, 2)); else writes.push([cp, bytes(JSON.stringify(next, null, 2))]);
    }

    // 3. Apply: moves first (so renamed files land before new content is written), then writes.
    for (const [from, to] of moves) await this.move(from, to);
    for (const [p, d] of writes) await this.write(p, d);
    const links = new Map<Action, string>();
    for (const [act, p, d] of compare) links.set(act, await this.saveForComparison(dir, p, d));

    // 4. Report.
    const report = `${dir}/Update Report.md`;
    await this.write(report, bytes(renderReport(plan, links)));
    this.data.installedVersion = plan.to;
    this.data.pendingReport = report;
    await this.saveData(this.data);
    return report;
  }
}

// ---- shared text helpers ----
function fmt(v: unknown): string {
  if (v === undefined) return "(not set)";
  const s = JSON.stringify(v);
  return "`" + (s.length > 100 ? s.slice(0, 97) + "…" : s) + "`";
}

function describeChange(c: SettingChange): string {
  if (c.added || c.removed) {
    const parts: string[] = [];
    if (c.added?.length) parts.push(`added ${c.added.map(fmt).join(", ")}`);
    if (c.removed?.length) parts.push(`removed ${c.removed.map(fmt).join(", ")}`);
    if (c.reordered) parts.push("changed the order");
    return parts.join("; ");
  }
  if (c.from === undefined) return `new setting: ${fmt(c.to)}`;
  if (c.to === undefined) return `removed (was ${fmt(c.from)})`;
  return `${fmt(c.from)} → ${fmt(c.to)}`;
}

const actionName = (act: Action) => act.label && act.path.startsWith(".obsidian/") ? act.label : act.path;

function renderReport(plan: Plan, links: Map<Action, string>): string {
  const link = (p: string) => p.startsWith(".obsidian/") ? `\`${p}\`` : `[[${p.replace(/\.md$/, "")}]]`;
  const lines = [
    `# LifeHQ ${plan.from} → ${plan.to}`, "",
    `Updated ${new Date().toLocaleString()}. Nothing you wrote was changed: this update only touched files that came with LifeHQ, and only the ones you checked.`, "",
    "Every file it changed was backed up first, in `Backup before update.zip` in this folder.", "",
  ];
  if (plan.fromDetected) lines.push(`> [!info] Your starting version (${plan.from}) was worked out from your files, since this is your first update with the LifeHQ Updater.`, "");

  const settingsActs = plan.actions.filter((a) => a.settings?.length);
  if (settingsActs.length) {
    const total = settingsActs.reduce((n, a) => n + a.settings!.length, 0);
    lines.push(`## Settings LifeHQ changed (${total} in ${settingsActs.length} ${settingsActs.length === 1 ? "file" : "files"})`, "",
      "Every setting LifeHQ changed since your version, and what happened in your vault:", "",
      "- ✅ Applied: your vault now has LifeHQ's change.",
      "- ✋ Kept yours: you had changed this setting yourself and left it unchecked.",
      "- ⏭️ Skipped: you unchecked it, so LifeHQ's change wasn't applied.", "");
    for (const act of settingsActs) {
      lines.push(`### ${act.label ?? act.path}`, "", `\`${act.path}\``, "");
      for (const c of act.settings!) {
        const status = c.applied ? "✅" : c.recommended ? "⏭️" : "✋";
        const tail = c.applied ? (c.recommended ? "" : ". Replaced your value") : c.recommended ? "" : `. Kept yours: ${fmt(c.yours)}`;
        lines.push(`- ${status} \`${c.key || "the whole list"}\`: ${describeChange(c)}${tail}`);
        if (c.reason) lines.push(`\t- Why: ${c.reason}`);
      }
      const l = links.get(act);
      if (l) lines.push(`- LifeHQ ${plan.to}'s full settings file: [[${l.replace(/\.md$/, "")}|view]]`);
      lines.push("");
    }
  }

  for (const s of SECTIONS) {
    const acts = plan.actions.filter((x) => s.kind.includes(x.kind) && listed(x));
    if (!acts.length) continue;
    lines.push(`## ${s.title} (${acts.length})`, "", s.blurb, "");
    for (const act of acts) {
      let l = `- ${act.selected ? "✅" : "⏭️"} ${act.label && act.path.startsWith(".obsidian/") ? `${act.label} (\`${act.path}\`)` : link(act.path)}`;
      if (act.to && act.kind === "rename") l += ` → ${link(act.to)}`;
      if (act.note) l += ` (${act.note})`;
      if (act.selected && !act.recommended && s.checked) l += `: ${s.checked}`;
      if (!act.selected && act.recommended) l += ": skipped, you unchecked it";
      const cmp = links.get(act);
      if (cmp) l += `\n\t- LifeHQ ${plan.to} version: [[${cmp.replace(/\.md$/, "")}|compare]]`;
      lines.push(l);
    }
    lines.push("");
  }
  lines.push(`${plan.unchanged} other LifeHQ files were already up to date.`, "");
  return lines.join("\n");
}

// ---- modals ----
class SignInModal extends Modal {
  constructor(app: App, private plugin: LifeHQUpdater, private then: () => void) { super(app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("lifehq-updater");
    contentEl.createEl("h2", { text: "Turn on LifeHQ updates" });
    contentEl.createEl("p", { text: "Updates come with LifeHQ, Library Pro, Library VIP, and Library Lifetime. Enter the email you bought with and we'll send you a code." });
    const email = contentEl.createEl("input", { type: "email", attr: { placeholder: "you@example.com" }, cls: "lifehq-input" });
    email.value = this.plugin.data.email ?? "";
    const status = contentEl.createEl("p", { cls: "setting-item-description" });
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    const send = row.createEl("button", { text: "Email me a code", cls: "mod-cta" });
    send.onclick = async () => {
      send.disabled = true; status.setText("Checking your purchase…");
      const r = await this.plugin.api("start", { method: "POST", body: { email: email.value } });
      send.disabled = false;
      if (r.status !== 200) { status.setText(r.json.error ?? `Something went wrong (${r.status}).`); return; }
      this.codeStep(String(r.json.challenge), String(r.json.email));
    };
    email.addEventListener("keydown", (e) => { if (e.key === "Enter") send.click(); });
    email.focus();
  }
  codeStep(challenge: string, address: string) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Check your email" });
    contentEl.createEl("p", { text: `We sent a code to ${address}. It expires in 15 minutes.` });
    const code = contentEl.createEl("input", { type: "text", attr: { placeholder: "ABCD-EFGH", autocomplete: "one-time-code" }, cls: "lifehq-input lifehq-code" });
    const status = contentEl.createEl("p", { cls: "setting-item-description" });
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Use a different email" }).onclick = () => { contentEl.empty(); this.onOpen(); };
    const go = row.createEl("button", { text: "Verify", cls: "mod-cta" });
    go.onclick = async () => {
      go.disabled = true; status.setText("Checking…");
      const r = await this.plugin.api("verify", { method: "POST", body: { challenge, code: code.value } });
      go.disabled = false;
      if (r.status !== 200) { status.setText(r.json.error ?? `Something went wrong (${r.status}).`); return; }
      this.plugin.data.token = String(r.json.token);
      this.plugin.data.email = String(r.json.email);
      await this.plugin.saveData(this.plugin.data);
      new Notice(`LifeHQ updates are on for ${r.json.email}.`);
      this.close();
      this.then();
    };
    code.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
    code.focus();
  }
  onClose() { this.contentEl.empty(); }
}

class UpdaterSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: LifeHQUpdater) { super(app, plugin); }
  display() {
    const { containerEl } = this, d = this.plugin.data;
    containerEl.empty();
    new Setting(containerEl).setName("Installed version").setDesc(d.installedVersion ? `LifeHQ ${d.installedVersion}` : "Not recorded yet. It's worked out from your files on your first update.");
    new Setting(containerEl).setName("Updates").setDesc(d.email ? `Signed in as ${d.email}.` : "Not signed in.")
      .addButton((b) => b.setButtonText("Check for updates").setCta().onClick(() => this.plugin.checkForUpdates(true)))
      .addButton((b) => b.setButtonText(d.email ? "Sign out" : "Sign in").onClick(async () => {
        if (d.email) { await this.plugin.signOut(); this.display(); }
        else new SignInModal(this.app, this.plugin, () => this.display()).open();
      }));
  }
}

interface Item { id: string; recommended: boolean; box: HTMLInputElement; }

export class ChecklistModal extends Modal {
  selection: Selection = new Map();
  items: Item[] = [];
  groups: { box: HTMLInputElement; members: Item[] }[] = [];
  goBtn!: HTMLButtonElement;

  constructor(app: App, private plugin: LifeHQUpdater, private plan: Plan, private replan?: (from: string) => Promise<Plan>) { super(app); }

  onOpen() {
    const { contentEl, modalEl } = this, plan = this.plan;
    contentEl.empty();
    this.selection = new Map(); this.items = []; this.groups = [];
    modalEl.addClass("lifehq-updater-modal");
    contentEl.addClass("lifehq-updater");
    contentEl.createEl("h2", { text: `Update LifeHQ to ${plan.to}` });
    // Starting version: worked out from their files the first time; they can correct it.
    const from = contentEl.createDiv({ cls: "lifehq-from" });
    from.createSpan({ text: "Updating from LifeHQ " });
    const pickFrom = from.createEl("select", { cls: "dropdown" });
    for (const v of plan.versions) pickFrom.createEl("option", { text: v, value: v });
    pickFrom.value = plan.from;
    pickFrom.disabled = !this.replan;
    from.createSpan({ text: plan.fromDetected ? " (worked out from your files; change it if that's not right)" : "", cls: "setting-item-description" });
    pickFrom.onchange = async () => {
      if (!this.replan) return;
      pickFrom.disabled = true;
      this.plan = await this.replan(pickFrom.value);
      this.onOpen();
    };
    const visible = plan.actions.filter((a) => a.kind !== "self");
    if (!visible.length) { contentEl.createEl("p", { text: `You're already up to date with LifeHQ ${plan.to}.` }); return; }
    contentEl.createEl("p", { text: "Check everything you want updated, then click Update. Recommended changes are already checked. Anything that would replace your own changes starts unchecked. Every file this changes is backed up first." });
    for (const w of plan.warnings) contentEl.createEl("p", { text: w, cls: "mod-warning" });

    const bulk = contentEl.createDiv({ cls: "lifehq-bulk" });
    bulk.createEl("button", { text: "Recommended" }).onclick = () => this.setAll((i) => i.recommended);
    bulk.createEl("button", { text: "Select all" }).onclick = () => this.setAll(() => true);
    bulk.createEl("button", { text: "Select none" }).onclick = () => this.setAll(() => false);

    // Settings: one checkbox per setting, grouped by file.
    const settingsActs = plan.actions.filter((a) => a.settings?.length);
    if (settingsActs.length) {
      const sec = contentEl.createDiv({ cls: "lifehq-section" });
      sec.createEl("h3", { text: "Settings LifeHQ changed" });
      sec.createEl("p", { text: "Checked settings get LifeHQ's new value. ✋ marks settings you changed yourself.", cls: "setting-item-description" });
      for (const act of settingsActs) {
        const members: Item[] = [];
        const head = this.groupHeader(sec, act.label ?? act.path);
        const ul = sec.createEl("ul", { cls: "lifehq-list" });
        for (const c of act.settings!) {
          const li = ul.createEl("li");
          const item = this.checkbox(li, settingId(act, c), c.recommended, `${c.recommended ? "" : "✋ "}${c.key || "the whole list"}: ${describeChange(c).replace(/`/g, "")}${c.recommended ? "" : ` (yours: ${fmt(c.yours).replace(/`/g, "")})`}`);
          if (c.reason) li.createDiv({ text: `Why: ${c.reason}`, cls: "setting-item-description lifehq-why" });
          members.push(item);
        }
        this.groups.push({ box: head, members });
      }
    }

    // Plugins and files, one checkbox each.
    for (const s of SECTIONS) {
      const acts = visible.filter((x) => s.kind.includes(x.kind) && listed(x));
      if (!acts.length) continue;
      const sec = contentEl.createDiv({ cls: "lifehq-section" });
      const members: Item[] = [];
      const head = this.groupHeader(sec, `${s.title} (${acts.length})`, "h3");
      sec.createEl("p", { text: s.blurb, cls: "setting-item-description" });
      const ul = sec.createEl("ul", { cls: "lifehq-list" });
      for (const act of acts) {
        const li = ul.createEl("li");
        const label = `${act.kind === "rename" ? `${act.path} → ${act.to}` : actionName(act)}${act.note ? ` (${act.note})` : ""}`;
        members.push(this.checkbox(li, act.id, act.recommended, label));
      }
      this.groups.push({ box: head, members });
    }

    const row = contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    this.goBtn = row.createEl("button", { cls: "mod-cta" });
    this.goBtn.onclick = async () => {
      this.goBtn.disabled = true; this.goBtn.setText("Updating…");
      try {
        await this.plugin.applyPlan(plan, this.selection);
        this.close();
        new DoneModal(this.app).open();
      } catch (e) {
        this.goBtn.setText("Update failed");
        contentEl.createEl("p", { text: `Something went wrong: ${(e as Error).message}. Your backup is in the LifeHQ Updates folder.`, cls: "mod-warning" });
      }
    };
    this.refresh();
  }

  groupHeader(parent: HTMLElement, title: string, tag: "h3" | "h4" = "h4"): HTMLInputElement {
    const h = parent.createEl(tag, { cls: "lifehq-group" });
    const box = h.createEl("input", { type: "checkbox" });
    h.createSpan({ text: ` ${title}` });
    box.onchange = () => {
      const g = this.groups.find((x) => x.box === box)!;
      for (const m of g.members) { m.box.checked = box.checked; this.selection.set(m.id, box.checked); }
      this.refresh();
    };
    return box;
  }

  checkbox(parent: HTMLElement, id: string, recommended: boolean, label: string): Item {
    const l = parent.createEl("label", { cls: "lifehq-item" });
    const box = l.createEl("input", { type: "checkbox" });
    box.checked = recommended;
    l.createSpan({ text: label });
    const item = { id, recommended, box };
    box.onchange = () => { this.selection.set(id, box.checked); this.refresh(); };
    this.items.push(item);
    return item;
  }

  setAll(fn: (i: Item) => boolean) {
    for (const i of this.items) { i.box.checked = fn(i); this.selection.set(i.id, i.box.checked); }
    this.refresh();
  }

  refresh() {
    for (const g of this.groups) {
      const on = g.members.filter((m) => m.box.checked).length;
      g.box.checked = on === g.members.length;
      g.box.indeterminate = on > 0 && on < g.members.length;
    }
    const n = this.items.filter((i) => i.box.checked).length;
    this.goBtn.setText(n ? `Back up & update ${n} ${n === 1 ? "item" : "items"}` : "Nothing selected");
    this.goBtn.disabled = n === 0 && !this.plan.actions.some((a) => a.kind === "self");
  }

  onClose() { this.contentEl.empty(); }
}

class DoneModal extends Modal {
  onOpen() {
    this.contentEl.createEl("h2", { text: "LifeHQ is updated" });
    this.contentEl.createEl("p", { text: "Reload Obsidian to finish. Your update report opens right after." });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Reload now", cls: "mod-cta" }).addEventListener("click", () => {
      (this.app as unknown as { commands: { executeCommandById(id: string): void } }).commands.executeCommandById("app:reload");
    });
  }
  onClose() { this.contentEl.empty(); }
}
