import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, exec, hc, run, appHome, home, terminals, spaces, panes, window } from "herdr";

// List servers under the agents. Click a server to open its logs.

const SCAN_MS = 4000;                 // ss + docker ps are cheap; servers come and go fast
const LOG_TAIL_LINES = "200";
const LOG_LABEL = "herdr.ports.logs";
const PEEK_WAIT_MS = 3000;

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

// hc prints its error as JSON on stdout: {"error": {"message": ...}}.
function hcError(r) {
  try {
    const message = JSON.parse(r.stdout)?.error?.message;
    if (message) return message;
  } catch {}
  return r.stderr.trim().split("\n").pop() || `hc run exited ${r.code}`;
}

function hostLabel(hosts) {
  return hosts.every((h) => h === "127.0.0.1" || h === "::1" || h === "localhost") ? "local" : "network";
}

// Owned by the agents view: start(cx) from its init, rows(t, collapsed) inside its list.
export class Servers {
  start(cx) {
    this.data = null;
    this.error = null;
    this.logsError = null;
    this.hovered = null;
    this.folded = new Set();
    this.scanning = false;
    this.opening = new Set();
    if (checking()) return;
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

  // Read the host lists once per render: every host read copies the whole list into JS.
  snapshot() {
    this.terms = new Map(terminals().map((t) => [t.address, t]));
    this.spaceList = spaces();
    const tabs = new Map();
    for (const s of this.spaceList) for (const tab of s.tabs) tabs.set(tab.id, { space: s, tab });
    this.places = new Map();
    for (const p of panes()) if (p.terminal && tabs.has(p.tab)) this.places.set(p.terminal, tabs.get(p.tab));
  }

  where(address) {
    const term = this.terms.get(address);
    if (!term) return address;
    const where = term.where ?? term.labels?.where;
    if (where) return where;
    const space = this.spaceList.find((s) => s.id === term.labels?.["herdr.space"]);
    return space?.name ?? address;
  }

  // The space a terminal is in, and its tab. A terminal with no pane (one started with
  // `hc run --bg`) has only its space label, so its tab falls back to where().
  placeOf(address) {
    const known = this.places.get(address);
    if (known) return { id: known.space.id, name: known.space.name, order: known.space.index, tab: known.tab.name };
    const space = this.spaceList.find((s) => s.id === this.terms.get(address)?.labels?.["herdr.space"]);
    if (space) return { id: space.id, name: space.name, order: space.index, tab: this.where(address) };
    return { id: "", name: "Other", order: Infinity, tab: this.where(address) };
  }

  openBrowser(port) {
    const url = `http://localhost:${port}`;
    const platform = window()?.platform;
    const [cmd, args] = platform === "macos" ? ["open", [url]] : platform === "windows" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    exec(cmd, args).catch(() => {});
  }

  showPort(p, cx) {
    if (p.log_files.length) {
      return this.followLogs(`file:${JSON.stringify(p.log_files)}`, ["tail", "-n", LOG_TAIL_LINES, "-F", "--", ...p.log_files], cx);
    }
    this.logsError = null;
    try {
      if (!p.terminal_output || !terminals().some((t) => t.address === p.terminal && t.state === "live")) {
        throw new Error("No log file or live terminal output was found for this server");
      }
      run("terminal.peek", { terminal: p.terminal });
    } catch (e) {
      this.logsError = `Couldn't open logs: ${e?.message ?? e}`;
    }
    cx.notify();
  }

  showService(s, cx) {
    const command = ["docker", "logs", "--follow", "--tail", LOG_TAIL_LINES, s.container_id];
    this.followLogs(`container:${s.container_id}`, command, cx);
  }

  // Every service of the project together: the terminal running `docker compose up`,
  // else a `docker compose logs -f` terminal of our own.
  showProject(s, cx) {
    if (s.project_terminal && terminals().some((t) => t.address === s.project_terminal && t.state === "live")) {
      this.logsError = null;
      run("terminal.peek", { terminal: s.project_terminal });
      cx.notify();
      return;
    }
    const command = ["docker", "compose", "-p", s.project, "logs", "-f", "--tail", LOG_TAIL_LINES];
    this.followLogs(s.project, command, cx, s.workdir_exists ? s.workdir : null);
  }

  followLogs(key, command, cx, cwd = null) {
    if (this.opening.has(key)) return;
    this.opening.add(key);
    this.logsError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        let term = terminals().find((t) => t.labels?.[LOG_LABEL] === key && t.state === "live");
        if (!term) {
          const args = ["run", "--bg", "--no-parent", "--json", "--label", `${LOG_LABEL}=${key}`];
          if (cwd) args.push("--cwd", cwd);
          const r = await hc([...args, "--", ...command]);
          if (r.code !== 0) throw new Error(hcError(r));
          const address = JSON.parse(r.stdout).address;
          const deadline = Date.now() + PEEK_WAIT_MS;
          term = terminals().find((t) => t.address === address);
          while (!term && Date.now() < deadline) {
            await cx.sleep(100);
            term = terminals().find((t) => t.address === address);
          }
          if (!term) throw new Error(`Terminal ${address} didn't show up`);
        }
        run("terminal.peek", { terminal: term.address });
      } catch (e) {
        this.logsError = `Couldn't open logs: ${e?.message ?? e}`;
        cx.notify();
      } finally {
        this.opening.delete(key);
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

  portRow(p, place, t) {
    const id = `srv-port-${p.port}-${p.pid}`;
    const files = p.log_files.map(shortPath);
    const hasTerminal = p.terminal_output && this.terms.get(p.terminal)?.state === "live";
    const available = files.length > 0 || hasTerminal;
    const source = files.length ? files.map((path) => path.split("/").pop()).join(", ") : place.tab;
    return h_flex().id(id).px(8).py(5).flex_none().rounded(8).gap(9).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover(this.hover(id))
      .tooltip([p.argv.join(" "), p.cwd, ...files, available ? "Click to open logs" : "Logs unavailable"].filter(Boolean).join("\n"))
      .on_click((_e, cx) => this.showPort(p, cx))
      .child(svg("mods/workspace-chrome/terminal.svg").size(14).flex_none().text_color(t.working))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center()
          .child(div().font_semibold().text_color(t.foreground).child(`:${p.port}`))
          .child(div().min_w(0).truncate().text_color(t.muted).child(processLabel(p))))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(`${available ? source : "Logs unavailable"} · ${hostLabel(p.hosts)}`)))
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
      .tooltip(`${s.container}: ${s.status}\nClick to open logs`)
      .on_click((_e, cx) => this.showService(s, cx))
      .child(div().size(7).mx(3).rounded(4).flex_none().bg(dot))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center()
          .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(s.service))
          .when(Boolean(ports), (el) => el.child(div().flex_none().text_color(t.muted).child(ports))))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(`${s.state}${health}`)))
      .when(this.hovered === id && s.ports.length > 0, (el) => el.child(this.browserButton(`${id}-open`, s.ports[0].host, t)));
  }

  logsButton(id, s, t) {
    return div().id(id).flex_none().px(5).h(18).rounded(5).flex().items_center()
      .text_size(11).font_normal().text_color(t.muted).hover((st) => st.bg(t.raised).text_color(t.foreground))
      .tooltip(`Follow all ${s.project} services' logs`)
      .on_click((_e, cx) => { cx.stop_propagation(); this.showProject(s, cx); })
      .child("logs");
  }

  // A group's header, styled like the agents' space headers; it folds the group.
  // Folded, it says how many, and a red dot when a service in it is unhealthy.
  groupHeader(g, t) {
    const open = !this.folded.has(g.id);
    const unhealthy = g.services?.some((s) => s.health === "unhealthy");
    return h_flex().id(g.id).px(8).pt(8).h(30).flex_none().gap(6).items_center()
      .text_size(11).font_medium().text_color(t.dim)
      .cursor_pointer().hover((st) => st.text_color(t.foreground))
      .on_hover(this.hover(g.id))
      .when(Boolean(g.tip), (el) => el.tooltip(g.tip))
      .on_click((_e, cx) => {
        open ? this.folded.add(g.id) : this.folded.delete(g.id);
        cx.notify();
      })
      .when(Boolean(g.services), (el) => el.child(svg("mods/workspace-chrome/layers.svg").size(12).flex_none()))
      .child(div().min_w(0).truncate().child(g.label))
      .when(!open, (el) => el.child(div().child(String(g.members.length))))
      .child(div().flex_1())
      .when(Boolean(g.project) && this.hovered === g.id, (el) => el.child(this.logsButton(`${g.id}-logs`, g.services[0], t)))
      .when(!open, (el) => el
        .when(unhealthy, (el) => el.child(div().size(7).mx(3).rounded(4).flex_none().bg(t.blocked)))
        .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none()));
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

  collapsedRows(ports, services, t) {
    const portRows = ports.map((p) => ({ id: `srv-cp-${p.port}-${p.pid}`, port: p.port, tip: `${processLabel(p)} · ${this.where(p.terminal)}`, click: (cx) => this.showPort(p, cx) }));
    const containerRows = services.map((s) => ({ id: `srv-cs-${s.container}`, port: s.ports[0]?.host ?? "·", tip: s.project ? `${s.project}/${s.service}` : s.container, click: (cx) => this.showService(s, cx) }));
    const rows = [...portRows, ...containerRows].map((r) => div().id(r.id).h(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_size(10.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(r.tip).on_click((_e, cx) => r.click(cx)).child(String(r.port)));
    return rows.length ? [div().mx(10).my(6).h(1).flex_none().bg(t.border), ...rows] : [];
  }

  rows(t, collapsed) {
    this.snapshot();
    const ports = this.data?.ports ?? [];
    const services = [...(this.data?.compose ?? []), ...(this.data?.containers ?? [])];
    if (collapsed) return this.collapsedRows(ports, services, t);
    const note = this.error ?? this.logsError ?? this.data?.docker_error ?? null;
    const out = [this.header(t, ports.length + services.length)];
    if (note) out.push(div().px(8).pb(4).flex_none().text_size(11).text_color(t.blocked).truncate().tooltip(note).child(note));
    if (this.data && !ports.length && !services.length) {
      out.push(div().px(8).flex_none().text_size(12).text_color(t.dim)
        .child("No servers yet. Servers started in Herdr and running Docker containers show here."));
    }
    // Group local processes by space and containers by Compose project.
    const bySpace = new Map();
    for (const p of ports) {
      const place = this.placeOf(p.terminal);
      const id = `srv-sp-${place.id}`;
      if (!bySpace.has(id)) bySpace.set(id, { id, label: place.name, order: place.order, members: [] });
      bySpace.get(id).members.push({ p, place });
    }
    const byProject = new Map();
    for (const s of services) {
      const id = `srv-docker-${s.project ?? ""}`;
      if (!byProject.has(id)) {
        const members = [];
        const label = s.project ?? "Docker";
        const tip = s.workdir ? `${label}  ${shortPath(s.workdir)}` : label;
        byProject.set(id, { id, label, tip, project: s.project, services: members, members });
      }
      byProject.get(id).members.push(s);
    }
    for (const g of [...bySpace.values()].sort((a, b) => a.order - b.order)) {
      out.push(this.groupHeader(g, t));
      if (!this.folded.has(g.id)) for (const m of g.members) out.push(this.portRow(m.p, m.place, t));
    }
    for (const g of byProject.values()) {
      out.push(this.groupHeader(g, t));
      if (!this.folded.has(g.id)) for (const s of g.members) out.push(this.serviceRow(s, t));
    }
    return out;
  }
}
