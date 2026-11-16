// Modified from the workspace-status mod that ships with Herdr (Apache License 2.0):
// adds agent plan usage (usage.js) to the status bar.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, theme, run, window, keys } from "herdr";
import { Usage } from "./usage.js";

// Status bar width (px) at which provider names fit beside their icons.
const USAGE_FULL_AT = 1000;

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.width = 0;
    this.usage = new Usage();
    this.usage.start(cx);
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const mode = this.width >= USAGE_FULL_AT ? "full" : "compact";
    return h_flex().id("root").on_size_change((size, cx) => { this.width = size.width; cx.notify(); }).size_full().overflow_hidden().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .child(div().flex_1())
      .child(this.usage.render(t, mode))
      .child(div().w(1).h(12).bg(t.border).flex_none())
      .child(div().id("palette").flex_none().text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
