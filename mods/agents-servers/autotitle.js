import { agents, spaces, run, shared } from "herdr";

// Names each tab after what its agent is working on: the title the agent gives
// its terminal (Claude Code sets one from the conversation's topic). A tab you
// name yourself is left alone; renaming it to "" hands it back.

const CHECK_MS = 3000;
const MAX_LENGTH = 40;
const STORE = "autotitles";       // tab id -> the name we gave it
export const AUTOTITLE_KEY = "agents.autotitle";

export const autotitleOn = () => shared(AUTOTITLE_KEY) !== false;

// The agent's title as a tab name, or null when it says nothing about the work:
// empty, a folder, user@host, or just the program's name.
function topic(a) {
  const raw = (a.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
  if (!raw || /^[~/]|^[A-Za-z]:\\/.test(raw) || raw.includes("@")) return null;
  const words = raw.toLowerCase();
  const prog = a.program;
  if ([prog?.name, prog?.key, a.app].some((n) => n && n.toLowerCase() === words)) return null;
  if (/^(claude|claude code|codex|opencode|gemini|amp|copilot|cursor agent)$/.test(words)) return null;
  return raw.length > MAX_LENGTH ? `${raw.slice(0, MAX_LENGTH - 1).trimEnd()}…` : raw;
}

export class AutoTitle {
  start(cx) {
    try { this.given = JSON.parse(localStorage.getItem(STORE) ?? "{}"); } catch { this.given = {}; }
    cx.timer.every(CHECK_MS, () => this.check());
    this.check();
  }

  save() {
    try { localStorage.setItem(STORE, JSON.stringify(this.given)); } catch { /* names just aren't remembered */ }
  }

  check() {
    if (!autotitleOn()) return;
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    let dirty = false;
    for (const id of Object.keys(this.given)) {
      if (!tabs.has(id)) { delete this.given[id]; dirty = true; }
    }
    const done = new Set();
    for (const a of agents()) {          // pane order: a tab's first agent names it
      if (done.has(a.tab)) continue;
      done.add(a.tab);
      const tab = tabs.get(a.tab);
      const name = tab && topic(a);
      if (!name || (tab.named && tab.name === name)) continue;
      const ours = this.given[a.tab];
      if (tab.named && tab.name !== ours) {
        // Named by someone else: theirs to keep.
        if (ours) { delete this.given[a.tab]; dirty = true; }
        continue;
      }
      run("tab.rename", { id: a.tab, name });
      this.given[a.tab] = name;
      dirty = true;
    }
    if (dirty) this.save();
  }
}
