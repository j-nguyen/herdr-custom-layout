# Plan: Simplify the bottom-left sidebar

**Status:** Accepted
**Date** 2026-11-25
**Scope** Small. The lower-left pane in `main-custom`.

## Goal

Make the lower-left pane easier to scan.

## Requirements

- R1. Reduce clutter from Agents, Servers and Other.
- R2. Keep agent status, actions and keyboard order. Keep server logs, browser links and refresh accessible.

## Current state

- Both lists share a scroll area in the lower block. `layouts/main-custom.json:39`, `mods/agents-servers/main.js:475`.
- The live view showed 15 servers and repeated worktree names. Servers group by space or Docker project. `mods/agents-servers/servers.js:296`.
- Other starts open and holds processes with no matching space. `mods/agents-servers/servers.js:93`, `mods/agents-servers/servers.js:315`.
- The rail adds one cell per server. The mod sets agent order on render. `mods/agents-servers/servers.js:275`, `mods/agents-servers/main.js:271`.

## Decisions

- **D1.** Show one list under a fixed Agents and Servers selector. Start on Agents. Reset scroll on switches.
  Folding Servers in place would still leave it below every agent. Keep selection in the view instance.
- **D2.** Keep the sort and tab naming menu on Agents. Move refresh to the Servers header. Show a muted nonzero server count.
  Mark Agents with a Needs you dot while hidden if the current priority calculation finds a block.
- **D3.** Rename Other to Unassigned. Start it folded with a count. Keep it after named spaces and remember its fold state across switches.
- **D4.** Keep the agent icon rail and its expand control. Replace server cells with one fixed Servers icon with a tooltip.
  Click it to expand straight to Servers. Publish agent order in either view.

## Implementation steps

1. In `mods/agents-servers/main.js`, render the selector and active list. Done when C1, the Agents parts of C2 and C4 pass.
2. In `mods/agents-servers/servers.js`, reuse scan and row actions. Done when the Servers parts of C2 and C3 pass.
3. Update `README.md` and `RECIPE.md` to explain the selector and rail. Done when C5 passes.

## Test plan

- Run `herdr-app check mods/agents-servers` and check in Herdr. `~/.config/herdr-app/AGENTS.md:54`.
- In `main-custom`, check long lists, the rail, focus, pinning, folding, sort, tab naming, and next and previous agent commands.
- Check count, empty and error states, Unassigned, refresh, process and Docker logs, and browser links.

## Conformance checklist

- [ ] C1. Agents opens first. Each switch shows one list from the top. The selector stays visible. (D1, step 1)
- [ ] C2. Sort and refresh stay accessible. The count and dot follow current data. (D2, steps 1 and 2)
- [ ] C3. Unassigned keeps the space fallback and starts folded. Server row actions still work. (D3, step 2)
- [ ] C4. The rail keeps agent icons and one Servers shortcut. Agent order still updates in Servers. (D4, step 1)
- [ ] C5. The Herdr check passes and both docs match the sidebar. (D1–D4, step 3)
