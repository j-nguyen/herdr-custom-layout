import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { home, readTextFile, knownAgents, exec, window } from "herdr";

// Plan usage left for each agent account, drawn inside the status bar.
// Claude Code and Codex are asked live with the login each agent saved on this
// computer; tokens are sent only to that agent's own service. An agent you
// haven't logged into is left out.

const REFRESH_MS = 5 * 60 * 1000;   // usage changes slowly; the servers don't like polling
const CLOCK_MS = 60 * 1000;         // reset countdowns show minutes
const BAR_WIDTH = 44;
const COMPACT_BAR_WIDTH = 28;
const LOW_LEFT = 20;                // % left: red below this
const MID_LEFT = 50;                // % left: yellow below this

const WINDOW_NAMES = { 18000: "5h", 604800: "Week" };

async function readJson(path) {
  const text = await readTextFile(path);
  return text ? JSON.parse(text) : null;
}

// Thrown when an agent has no saved login here: that agent is left out of the bar.
class NoLogin extends Error {}

async function getJson(url, headers) {
  const res = await fetch(url, { headers: { "User-Agent": "herdr-agent-usage", Accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? "login expired" : `HTTP ${res.status}`);
  return res.json();
}

// Claude Code keeps its login in a file, or in the Keychain on macOS.
async function claudeCredentials() {
  const file = await readJson(`${home()}/.claude/.credentials.json`);
  if (file) return file;
  if (window()?.platform !== "macos") return null;
  try {
    const r = await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    return r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

async function claudeUsage() {
  const oauth = (await claudeCredentials())?.claudeAiOauth;
  if (!oauth?.accessToken) throw new NoLogin();
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) throw new Error("login expired: start claude");
  const u = await getJson("https://api.anthropic.com/api/oauth/usage", {
    Authorization: `Bearer ${oauth.accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
  });
  const meters = [];
  if (Array.isArray(u.limits) && u.limits.length) {
    for (const l of u.limits) {
      const name = l.kind === "session" ? "5h"
        : l.kind === "weekly_all" ? "Week"
        : l.scope?.model?.display_name ? `${l.scope.model.display_name} wk` : l.kind;
      meters.push({ name, used: l.percent ?? 0, resetsAt: Date.parse(l.resets_at) || null });
    }
  } else {
    for (const [key, name] of [["five_hour", "5h"], ["seven_day", "Week"], ["seven_day_opus", "Opus wk"], ["seven_day_sonnet", "Sonnet wk"]]) {
      const w = u[key];
      if (w) meters.push({ name, used: w.utilization ?? 0, resetsAt: Date.parse(w.resets_at) || null });
    }
  }
  return { plan: oauth.subscriptionType ?? null, meters };
}

async function codexUsage() {
  const auth = await readJson(`${home()}/.codex/auth.json`);
  const tokens = auth?.tokens;
  if (!tokens?.access_token) throw new NoLogin();
  const u = await getJson("https://chatgpt.com/backend-api/wham/usage", {
    Authorization: `Bearer ${tokens.access_token}`,
    "ChatGPT-Account-Id": tokens.account_id,
  });
  const meters = [];
  for (const w of [u.rate_limit?.primary_window, u.rate_limit?.secondary_window]) {
    if (!w) continue;
    const name = WINDOW_NAMES[w.limit_window_seconds] ?? `${Math.round(w.limit_window_seconds / 3600)}h`;
    meters.push({ name, used: w.used_percent ?? 0, resetsAt: w.reset_at ? w.reset_at * 1000 : null });
  }
  return { plan: u.plan_type ?? null, meters };
}

const PROVIDERS = [
  { id: "claude", label: "Claude", program: "claude", load: claudeUsage },
  { id: "codex", label: "Codex", program: "codex", load: codexUsage },
];

function untilText(ms) {
  if (ms == null) return "";
  const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

// Owned by the status bar view: call start(cx) from its init, render(t, mode) from its render.
// mode: "full" (words, bars, resets), "compact" (bars, numbers, resets), "tiny" (numbers only).
export class Usage {
  start(cx) {
    this.state = {};      // provider id -> { plan, meters } | { error }
    this.icons = {};
    this.loading = false;
    this.checkedAt = null;
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    cx.timer.every(CLOCK_MS, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      try {
        for (const p of await knownAgents()) this.icons[p.key] = p;
      } catch { /* icons are optional */ }
      cx.notify();
    });
    this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await Promise.all(PROVIDERS.map(async (p) => {
        try { this.state[p.id] = await p.load(); }
        catch (e) { this.state[p.id] = e instanceof NoLogin ? { absent: true } : { error: String(e?.message ?? e) }; }
      }));
      this.loading = false;
      this.checkedAt = Date.now();
      cx.notify();
    });
  }

  icon(p, t) {
    const prog = this.icons[p.program];
    const path = prog?.icon ?? `icons/${p.program}.svg`;
    return prog && !prog.tint ? image(path).w(13).h(13).flex_none()
      : svg(path).size(13).flex_none().text_color(t.foreground);
  }

  meter(m, t, id, mode) {
    const left = Math.max(0, Math.min(100, Math.round(100 - m.used)));
    const color = left < LOW_LEFT ? t.ansi1 : left < MID_LEFT ? t.ansi3 : t.ansi2;
    const reset = untilText(m.resetsAt);
    const barWidth = mode === "full" ? BAR_WIDTH : COMPACT_BAR_WIDTH;
    return h_flex().id(id).gap(5).items_center().flex_none()
      .tooltip(`${m.name}: ${Math.round(m.used)}% used, ${left}% left${reset ? `, resets in ${reset}` : ""}`)
      .child(div().text_color(t.muted).child(m.name))
      .when(mode !== "tiny", (el) => el.child(div().w(barWidth).h(5).rounded(3).bg(t.raised).overflow_hidden()
        .child(div().h(5).w(Math.round((barWidth * left) / 100)).rounded(3).bg(color))))
      .child(div().text_color(mode === "tiny" ? color : t.foreground).child(mode === "full" ? `${left}% left` : `${left}%`))
      .when(Boolean(reset) && mode !== "tiny", (el) => el.child(div().text_color(t.dim).child(reset)));
  }

  provider(p, t, mode) {
    const s = this.state?.[p.id];
    const row = h_flex().gap(10).items_center().flex_none()
      .child(h_flex().gap(5).items_center().child(this.icon(p, t))
        .child(div().text_color(t.foreground).child(mode === "full" ? p.label : p.short ?? p.label))
        .when(Boolean(s?.plan) && mode === "full", (el) => el.child(div().text_color(t.dim).child(s.plan))));
    if (!s) return row.child(div().text_color(t.dim).child("…"));
    if (s.error) return row.child(div().text_color(t.blocked).child(s.error));
    if (!s.meters.length) return row.child(div().text_color(t.dim).child("no limits"));
    return row.children(s.meters.map((m, i) => this.meter(m, t, `usage-${p.id}-${i}`, mode)));
  }

  render(t, mode) {
    const ago = this.checkedAt ? Math.floor((Date.now() - this.checkedAt) / 60000) : null;
    const checked = ago == null ? "" : ago < 1 ? "checked just now" : `checked ${ago}m ago`;
    const parts = [];
    PROVIDERS.filter((p) => !this.state?.[p.id]?.absent).forEach((p, i) => {
      if (i) parts.push(div().w(1).h(12).bg(t.border).flex_none());
      parts.push(this.provider(p, t, mode));
    });
    return h_flex().gap(14).items_center().flex_none()
      .children(parts)
      .child(div().id("usage-refresh").flex_none().text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .tooltip(`Refresh agent usage${checked ? ` (${checked})` : ""}`)
        .on_click((_e, cx) => this.refresh(cx))
        .child(this.loading ? "…" : "↻"));
  }
}
