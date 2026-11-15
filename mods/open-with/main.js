// "Open with" menu for a file or folder, opened as a popup by files-open and
// changes-open with props { path, dir, root }. ↑/↓ move, Enter runs, Esc closes.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, exec, home, notify, theme, window } from "herdr";

// macOS: the CLI inside the app bundle, so it works without the CLI on PATH.
// Linux: the CLI on PATH.
const EDITORS = [
  { name: "Zed", apps: ["Zed", "Zed Preview"], bin: "Contents/MacOS/cli", cli: ["zed", "zeditor"] },
  { name: "VS Code", apps: ["Visual Studio Code"], bin: "Contents/Resources/app/bin/code", cli: ["code"] },
];

async function findEditor(editor, mac) {
  const candidates = mac
    ? editor.apps.flatMap((app) => [`/Applications/${app}.app/${editor.bin}`, `${home()}/Applications/${app}.app/${editor.bin}`])
    : editor.cli;
  // macOS sh prints any absolute path for `command -v`, even a missing one.
  const script = 'for c; do case $c in /*) [ -x "$c" ] && echo "$c" && exit 0;; *) command -v "$c" && exit 0;; esac; done; exit 1';
  const r = await exec("sh", ["-c", script, "find", ...candidates]).catch(() => null);
  return r?.code === 0 ? r.stdout.trim().split("\n")[0] : null;
}

function items(p, mac, found) {
  if (!p?.path) return [];
  const parent = p.path.slice(0, p.path.lastIndexOf("/")) || "/";
  // With the project folder as well, the editor opens the file in that
  // project's window (a new one if it isn't open) instead of the last window.
  const target = p.root && p.path.startsWith(`${p.root}/`) ? [p.root, p.path] : [p.path];
  const list = EDITORS.map((e) => ({ label: `Open in ${e.name}`, icon: "square-pen", argv: found[e.name] ? [found[e.name], ...target] : null, missing: found[e.name] === null }));
  if (mac) {
    if (!p.dir) list.push({ label: "Open with default app", icon: "file-text", argv: ["open", p.path], gap: true });
    list.push({ label: p.dir ? "Open in Finder" : "Reveal in Finder", icon: "folder", argv: p.dir ? ["open", p.path] : ["open", "-R", p.path], gap: p.dir });
  } else {
    if (!p.dir) list.push({ label: "Open with default app", icon: "file-text", argv: ["xdg-open", p.path], gap: true });
    list.push({ label: p.dir ? "Open folder" : "Open containing folder", icon: "folder", argv: ["xdg-open", p.dir ? p.path : parent], gap: p.dir });
  }
  return list;
}

export default class OpenWith extends View {
  init(_props, cx) {
    this.at = 0;
    this.mac = window()?.platform === "macos";
    // undefined: still looking. null: not installed.
    this.found = {};
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      for (const e of EDITORS) this.found[e.name] = await findEditor(e, this.mac);
      cx.notify();
    });
  }

  choose(i, cx) {
    const it = items(props(), this.mac, this.found)[i];
    if (!it?.argv || this.opening !== undefined) return;
    const overlay = props().overlay;
    this.opening = i;
    cx.notify();
    // The menu stays open until the command returns, so a failure can be shown.
    cx.spawn(async () => {
      const r = await exec(it.argv[0], it.argv.slice(1)).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) notify({ title: `Couldn't ${it.label.toLowerCase()}`, body: r.stderr?.trim() || undefined, level: "error" });
      closeOverlay(overlay);
    });
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.mac, this.found);
    return v_flex()
      .id("open-with")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(Boolean(it.gap), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
              .id(`ow-${i}`)
              .h(31)
              .px(8)
              .gap(9)
              .rounded(7)
              .items_center()
              .text_color(it.argv ? t.foreground : t.dim)
              .when(i === this.at, (el) => el.bg(t.selected))
              .when(Boolean(it.argv), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
              .on_click((_e, cx) => this.choose(i, cx))
              .child(svg(`mods/workspace-chrome/${it.icon}.svg`).size(14).flex_none().text_color(t.muted))
              .child(div().flex_1().truncate().child(it.label))
              .when(it.missing, (el) => el.child(div().text_size(11).text_color(t.dim).child("not installed")))
              .when(this.opening === i, (el) => el.child(div().text_size(11).text_color(t.dim).child("opening…")))),
        ),
      );
  }
}
