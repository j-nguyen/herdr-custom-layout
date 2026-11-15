import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, hc, run, appHome, home, terminals, spaces, window } from "herdr";

// Servers you're running, listed right under the agents: TCP ports opened from a
// Herdr terminal (by you or an agent) and running Docker Compose services.
// Click one to peek at its output.

const SCAN_MS = 4000;                 // ss + docker ps are cheap; servers come and go fast
const LOG_TAIL_LINES = "200";
const LOG_LABEL = "herdr.ports.logs";

// "~/code/app", or "…/code/app" for a deep folder.
function shortPath(p) {
  if (!p) return "";
  const h = home();
  const tilde = p === h ? "~" : p.startsWith(`${h}/`) ? `~/${p.slice(h.length + 1)}` : p;
  const parts = tilde.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : tilde;
}

// What the process is, in a few words: "python3 http.server", "node vite", "uvicorn".
function processLabel(p) {
  const args = p.argv.slice(1).filter((a) => !a.startsWith("-") && !/^\d+$/.test(a));
  const script = args[0] ? args[0].split("/").pop() : "";
  return script && script !== p.comm ? `${p.comm} ${script}` : p.comm;
}

function hostLabel(hosts) {
  return hosts.every((h) => h === "127.0.0.1" || h === "::1" || h === "localhost") ? "local" : "network";
}

// Owned by the agents view: start(cx) from its init, rows(t, collapsed) inside its list.
export class Servers {
  start(cx) {
    this.data = null;
    this.error = null;
    this.hovered = null;
    this.scanning = false;
    cx.timer.every(SCAN_MS, (cx) => this.scan(cx));
    this.scan(cx);
  }

  scan(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        if (window()?.platform === "windows") throw new Error("Servers works on Linux and macOS");
        const r = await exec("python3", ["-I", `${appHome()}/mods/agents-servers/scan.py`], { timeout: 15000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `scan exited ${r.code}`);
        this.data = JSON.parse(r.stdout);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.scanning = false;
      cx.notify();
    });
  }

  where(address) {
    const term = terminals().find((t) => t.address === address);
    if (!term) return address;
    const where = term.where ?? term.labels?.where;
    if (where) return where;
    const space = spaces().find((s) => s.id === term.labels?.["herdr.space"]);
    return space?.name ?? address;
  }

  openBrowser(port) {
    const url = `http://localhost:${port}`;
    const platform = window()?.platform;
    const [cmd, args] = platform === "macos" ? ["open", [url]] : platform === "windows" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    exec(cmd, args).catch(() => {});
  }

  // One compose service's output: a terminal showing only that service, else a
  // `docker compose logs -f <service>` terminal of our own (made once, then reused).
  showService(s, cx) {
    if (s.terminal) return run("terminal.peek", { terminal: s.terminal });
    this.followLogs(`${s.project}/${s.service}`, s, [s.service], cx);
  }

  // Every service of the project together: the terminal running `docker compose up`,
  // else a `docker compose logs -f` terminal of our own.
  showProject(s, cx) {
    if (s.project_terminal) return run("terminal.peek", { terminal: s.project_terminal });
    this.followLogs(s.project, s, [], cx);
  }

  followLogs(key, s, services, cx) {
    const existing = terminals().find((t) => t.labels?.[LOG_LABEL] === key && t.state === "live");
    if (existing) return run("terminal.peek", { terminal: existing.address });
    cx.spawn(async (cx) => {
      const args = ["run", "--bg", "--json", "--label", `${LOG_LABEL}=${key}`];
      if (s.workdir) args.push("--cwd", s.workdir);
      args.push("--", "docker", "compose", "-p", s.project, "logs", "-f", "--tail", LOG_TAIL_LINES, ...services);
      try {
        const r = await hc(args);
        run("terminal.peek", { terminal: JSON.parse(r.stdout).address });
      } catch (e) {
        this.error = `couldn't open logs: ${e?.message ?? e}`;
        cx.notify();
      }
    });
  }

  hover(id) {
    return (on, cx) => {
      if (on) this.hovered = id;
      else if (this.hovered === id) this.hovered = null;
      cx.notify();
    };
  }

  browserButton(id, port, t) {
    return div().id(id).flex_none().px(5).h(20).rounded(5).flex().items_center()
      .text_size(11).text_color(t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .tooltip(`Open http://localhost:${port}`)
      .on_click((_e, cx) => { cx.stop_propagation(); this.openBrowser(port); })
      .child(`:${port} ↗`);
  }

  portRow(p, t) {
    const id = `srv-port-${p.port}-${p.pid}`;
    return h_flex().id(id).px(8).py(5).flex_none().rounded(8).gap(9).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover(this.hover(id))
      .tooltip(`${p.argv.join(" ")}\n${p.cwd ?? ""}\nClick to see its output`)
      .on_click(() => run("terminal.peek", { terminal: p.terminal }))
      .child(svg("mods/workspace-chrome/terminal.svg").size(14).flex_none().text_color(t.working))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center()
          .child(div().font_semibold().text_color(t.foreground).child(`:${p.port}`))
          .child(div().min_w(0).truncate().text_color(t.muted).child(processLabel(p))))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(`${this.where(p.terminal)} · ${hostLabel(p.hosts)}`)))
      .when(this.hovered === id, (el) => el.child(this.browserButton(`${id}-open`, p.port, t)));
  }

  serviceRow(s, t) {
    const id = `srv-svc-${s.container}`;
    const dot = s.health === "unhealthy" ? t.blocked : s.state === "running" ? (s.health === "healthy" || !s.health ? t.ansi2 : t.ansi3) : t.dim;
    const health = s.health ? ` · ${s.health}` : "";
    const ports = s.ports.map((p) => `:${p.host}`).join(" ");
    return h_flex().id(id).px(8).py(5).flex_none().rounded(8).gap(9).items_center()
      .cursor_pointer().hover((st) => st.bg(t.hover))
      .on_hover(this.hover(id))
      .tooltip(`${s.container}: ${s.status}\nClick to follow ${s.service} logs`)
      .on_click((_e, cx) => this.showService(s, cx))
      .child(div().size(7).mx(3).rounded(4).flex_none().bg(dot))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center()
          .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(s.service))
          .when(Boolean(ports), (el) => el.child(div().flex_none().text_color(t.muted).child(ports))))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(`${s.state}${health} · ${s.terminal ? this.where(s.terminal) : "logs"}`)))
      .when(this.hovered === id && s.ports.length > 0, (el) => el.child(this.browserButton(`${id}-open`, s.ports[0].host, t)));
  }

  projectHeader(s, t) {
    return h_flex().id(`srv-proj-${s.project}`).px(8).pt(6).pb(2).flex_none().gap(6).items_center()
      .text_size(11).text_color(t.dim)
      .cursor_pointer().hover((st) => st.text_color(t.foreground))
      .tooltip(`${s.project}: click to follow all services`)
      .on_click((_e, cx) => this.showProject(s, cx))
      .child(svg("mods/workspace-chrome/layers.svg").size(12).flex_none())
      .child(div().min_w(0).truncate().child(`${s.project}${s.workdir ? `  ${shortPath(s.workdir)}` : ""}`));
  }

  // The section header, styled like the Agents header above it.
  header(t, count) {
    return h_flex().id("srv-header").px(8).pt(16).pb(5).flex_none().items_center().justify_between()
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Servers"))
        .when(count > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(count)))))
      .child(div().id("srv-refresh").text_size(12).text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .tooltip("Scan again").on_click((_e, cx) => this.scan(cx)).child("↻"));
  }

  collapsedRows(t) {
    const ports = (this.data?.ports ?? []).map((p) => ({ id: `srv-cp-${p.port}-${p.pid}`, port: p.port, tip: `${processLabel(p)} · ${this.where(p.terminal)}`, click: () => run("terminal.peek", { terminal: p.terminal }) }));
    const svcs = (this.data?.compose ?? []).map((s) => ({ id: `srv-cs-${s.container}`, port: s.ports[0]?.host ?? "·", tip: `${s.project}/${s.service}`, click: (cx) => this.showService(s, cx) }));
    const rows = [...ports, ...svcs].map((r) => div().id(r.id).h(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_size(10.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(r.tip).on_click((_e, cx) => r.click(cx)).child(String(r.port)));
    return rows.length ? [div().mx(10).my(6).h(1).flex_none().bg(t.border), ...rows] : [];
  }

  rows(t, collapsed) {
    if (collapsed) return this.collapsedRows(t);
    const ports = this.data?.ports ?? [];
    const services = this.data?.compose ?? [];
    const note = this.error ?? this.data?.docker_error ?? null;
    const out = [this.header(t, ports.length + services.length)];
    if (note) out.push(div().px(8).pb(4).flex_none().text_size(11).text_color(t.blocked).truncate().tooltip(note).child(note));
    if (this.data && !ports.length && !services.length) {
      out.push(div().px(8).flex_none().text_size(12).text_color(t.dim)
        .child("No servers yet. Ports opened from a Herdr terminal and running Docker Compose services show here."));
    }
    for (const p of ports) out.push(this.portRow(p, t));
    let project = null;
    for (const s of services) {
      if (s.project !== project) { project = s.project; out.push(this.projectHeader(s, t)); }
      out.push(this.serviceRow(s, t));
    }
    return out;
  }
}
