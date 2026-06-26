# Semantic Graph View — Implementation Plan

A force-directed graph view that clones Obsidian's built-in graph, but where a note's
edges are its **N most semantically similar notes** instead of internal links. N is
configurable from the graph's settings.

This document is the build brief for the coding agent. It carries all the context needed:
the target behaviour (Obsidian's graph), the Obsidian APIs to lean on, and exactly which
parts of this plugin's application layer to consume. Read `AGENT.md` first — the
hexagonal boundaries below are non-negotiable.

---

## 1. Scope & guiding constraints

- **UI/orchestration only.** No new domain (similarity/embedding) logic. The similarity
  math already exists (`src/domain/embedding.ts`, `getSimilarNotes`). The graph only
  *consumes* it.
- **Match Obsidian's graph UX** as closely as practical (layout, controls panel, zoom/pan,
  hover highlight, click-to-open, right-click menu, node sizing, theming).
- **Edges = top-N similar notes**, not links. N is a graph setting.
- **Theme-native.** All colors come from Obsidian's graph CSS variables, never hardcoded.
- **Local-first / performance-aware.** Vaults can have thousands of notes; the graph must
  degrade gracefully (node cap, debounced recompute, progress while indexing).

---

## 2. Target behaviour — Obsidian's built-in graph (the spec to clone)

Source: Obsidian Help — Graph view. Replicate these, substituting "similar notes" for
"links" everywhere:

**Canvas & nodes**
- Circles = notes (nodes). Lines = edges. In our case an edge means "B is among A's top-N
  most similar notes."
- Node radius scales with degree (how many other nodes connect to it). More incoming
  similarity edges → bigger node.

**Interactions**
- Hover a node → highlight that node's edges and immediate neighbours; fade the rest.
- Click a node → open that note.
- Right-click a node → Obsidian file context menu (`workspace.trigger("file-menu", ...)`).
- Drag a node → pin/move it (held position while dragged, simulation reacts).
- Scroll wheel → zoom; `+`/`-` keys zoom; drag background → pan; arrow keys pan
  (Shift = faster). Keyboard is optional for MVP.

**Settings panel** (cog icon, top-right overlay on the canvas). Mirror the four sections:
- **Filters:** search-files text filter (filter nodes by Obsidian search term), toggles for
  Orphans (nodes with no similar-note edges above threshold) and Existing files only. Tags/
  Attachments toggles are N/A for a similarity graph — omit them.
- **Display:** Node size, Link thickness, Text fade threshold, (optional) Animate time-lapse.
- **Forces:** Center force, Repel force, Link force, Link distance.
- **NEW — "Similar links per node" (N):** the headline control unique to this view. Slider
  (e.g. 1–20, default 5). Optionally a "Minimum similarity" slider (maps to `minScore`).
- **Restore default settings** button.

**Graph types**
- **Global graph (MVP):** every indexed note + its top-N edges.
- **Local graph (stage 2, optional):** centered on the active note, expanded by depth. Depth
  slider. Reuse the same renderer; just seed from the active note and BFS the similarity
  edges to the chosen depth.

---

## 3. Obsidian plugin APIs to use

**View lifecycle** (`src/ui/SemanticGraphView.ts`, extends `ItemView`)
- `registerView(VIEW_TYPE_SEMANTIC_GRAPH, leaf => new SemanticGraphView(leaf, deps))` in
  `main.ts`, mirroring how `VIEW_TYPE_SIMILARITY` is registered today.
- Implement `getViewType()`, `getDisplayText()` ("Semantic graph"), `getIcon()`
  (e.g. `"git-fork"` or `"share-2"`), `onOpen()`, `onClose()` (must tear down the
  simulation, RAF loop, and event listeners).
- Activation: add a command ("Open semantic graph") and a ribbon icon. For a center/main
  leaf use `workspace.getLeaf(true)`; reuse the existing-leaf pattern from
  `src/app/activateRightLeafView.ts` (generalize it or add `activateGraphView.ts`).
- `registerHoverLinkSource(VIEW_TYPE_SEMANTIC_GRAPH, …)` so hover-preview works on nodes,
  as is already done for the similarity view.

**Opening / resolving notes** — note IDs in this plugin **are vault paths** (see
`SimilarNotesListView.openNote`). So:
- Title = `path.split("/").pop().replace(/\.md$/i, "")`.
- Open via `app.vault.getAbstractFileByPath(path)` → `instanceof TFile` →
  `workspace.getLeaf(false).openFile(file)`.
- Right-click menu: `const menu = new Menu(); workspace.trigger("file-menu", menu, file, "similarity-graph"); menu.showAtMouseEvent(evt);`

**Theming — colors MUST come from Obsidian.** The graph is canvas-rendered, so read the CSS
variables off the view container with `getComputedStyle(this.containerEl)` and feed them to
the canvas. Variables (Obsidian "Graph" CSS reference):

| Variable | Use |
| --- | --- |
| `--graph-node` | resolved node fill |
| `--graph-node-focused` | hovered/selected node |
| `--graph-node-unresolved` | (optional) notes not yet indexed |
| `--graph-line` | edge color |
| `--graph-text` | node label color |
| `--graph-controls-width` | controls panel width |

- Re-read these on theme/appearance change: `this.registerEvent(app.workspace.on("css-change", () => this.refreshThemeColors()))`.
- For highlight/fade, derive alpha variants from the same base colors (don't introduce new
  palette values).

**Misc**
- Use `createEl`/`createDiv` helpers (already used throughout) for the controls overlay DOM.
- Use `this.registerDomEvent` / `this.registerEvent` so listeners auto-clean on unload.
- Debounce recompute with the existing `KeyedDebouncer` (`src/domain/debouncer.ts`) or a
  simple local debounce.

---

## 4. This plugin's application layer — what to consume

The composition root is `AppContainer` (`src/appContainer.ts`); all use cases are wired
there and handed to views as `deps`. The graph view needs:

**Already available (consume as-is):**
- `getSimilarNotes({ noteId, limit, minScore })` → `RelatedNote[] = { id, score }[]`
  (`src/app/getSimilarNotes.ts`). This is the per-node edge source. `limit` = N.
- `indexRepo.listAll()` / `indexRepo.isEmpty()` (`src/ports/indexRepository.ts`) — the set
  of nodes. Each `IndexedNote` has `{ id, embedding, … }`.
- `subscribeIndexingState` / `getIndexingState` (`src/app/indexingCoordinator.ts`) — show a
  progress banner while indexing and trigger recompute when indexing settles (reuse the
  banner pattern from `SimilarNotesListView`).
- `startOrRefreshIndexSync` — "build index" affordance when empty.
- `isIgnoredPath` — filter ignored notes out of the node set.
- `settingsRepo.get()` / `updatePartial()` and `updateSettings` — persist graph settings.

**One thin app-layer addition (recommended) — `makeBuildSimilarityGraph`**

A global graph needs edges for *every* node, i.e. top-N for all nodes. Per `AGENT.md`,
"iterate over all nodes and assemble an adjacency structure" is a **workflow combining ports
+ domain → it belongs in `src/app`, not the UI.** This adds *no new domain logic* — it only
orchestrates the existing `getSimilarNotes`/`indexRepo` and the existing cosine math.

- File: `src/app/buildSimilarityGraph.ts`
  ```ts
  export type SimilarityGraph = {
    nodes: { id: string; degree: number }[];
    edges: { source: string; target: string; score: number }[];
  };
  export type BuildSimilarityGraphUseCase = (args: {
    linksPerNode: number;       // N
    minScore?: number;
    onProgress?: OnProgressCallback;
  }) => Promise<SimilarityGraph>;
  ```
- Implementation: `listAll()` → for each note compute its top-N (either call
  `getSimilarNotes({ noteId, limit: N, minScore })`, or, for speed, compute cosine directly
  against the in-memory embeddings using the existing `cosineSimilarity` from
  `src/domain/embedding.ts`). Dedupe directional pairs into undirected edges; edge weight =
  `max(scoreAB, scoreBA)`. Degree = count of distinct neighbours.
- Wire it into `AppContainer` and pass to the view as a dep, exactly like the other `makeX`
  use cases.
- **Decision flagged for the agent:** if you want to honour "no new code in `app`" literally,
  the UI may instead loop `getSimilarNotes` per node itself — but that pushes orchestration
  into the UI and violates `AGENT.md` §1 (UI must not own workflows). Prefer the app-layer
  use case. See §9.

**Performance note:** brute-force is O(n²) in embedding dimension. For large vaults run the
build off the main thread or in chunked `requestIdleCallback` batches with progress, and
cache the result; recompute only when N/minScore changes or indexing settles.

---

## 5. Rendering & simulation approach

**Recommended:** HTML5 Canvas 2D for drawing + `d3-force` for the layout simulation. This
mirrors Obsidian's own canvas/WebGL approach and matches existing community graph plugins
(e.g. obsidian-3d-graph uses d3). `d3-force` is layout math (presentation concern), so it
lives in the UI layer — it is not domain logic.

- Add dependency: `d3-force` (+ `@types/d3-force`). It is small and tree-shakeable; avoid
  pulling in all of `d3`.
- Forces: `forceSimulation(nodes)` with `forceLink(edges).id(d => d.id).distance(linkDistance).strength(linkForce)`, `forceManyBody().strength(-repelForce)`, `forceCenter()` (+ optional `forceX/forceY` for centerForce), `forceCollide(radius)`.
- Map the Forces-panel sliders directly onto these force parameters; call
  `simulation.alpha(…).restart()` on change.
- Draw loop: `requestAnimationFrame`; on each tick clear canvas, apply pan/zoom transform,
  draw edges then nodes then labels (labels gated by `textFadeThreshold` vs current zoom).
- Hit-testing for hover/click/drag: map mouse coords through the inverse pan/zoom transform,
  find nearest node within its radius. (Optional: quadtree from `d3-quadtree` for big graphs.)
- Handle DPI: scale canvas by `devicePixelRatio`. Handle resize via `ResizeObserver` and
  `onResize()`.

**Alternative (no new dependency):** hand-rolled Verlet/Barnes–Hut simulation. More code,
more risk, no upside — only choose this if adding a dependency is unacceptable. Flag in §9.

---

## 6. Settings model changes

Extend `SimilaritySettings` (`src/types.ts`) and `DEFAULT_SETTINGS` (`src/constants.ts`)
with a nested `graph` block so graph state persists and survives reloads:

```ts
graph: {
  linksPerNode: number;      // N, default 5
  minScore: number;          // default ~0.25 (matches getSimilarNotes default)
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
  nodeSize: number;
  linkThickness: number;
  textFadeThreshold: number;
  showOrphans: boolean;
  existingFilesOnly: boolean;
  searchFilter: string;
}
```

- Persist via `settingsRepo.updatePartial({ graph: … })` from the controls panel (debounced).
- **Important:** changing N / minScore must NOT trigger a full vault **re-embed**. The
  existing `updateSettings` use case force-reindexes when settings change — do **not** route
  graph-panel changes through it. Either persist graph settings via `settingsRepo` directly,
  or split graph settings into their own key the indexer ignores. Only the graph recomputes.
- The plugin-wide Settings tab (`src/ui/SettingsView.ts`) can optionally expose the same
  defaults, but the primary control surface is the in-view cog panel (matching Obsidian).

---

## 7. File-by-file work plan

Follow the `AGENT.md` implementation order (domain → ports → app → infra → container → UI).
No domain/ports/infra changes are required beyond the optional app use case.

1. `src/types.ts` — add `graph` block to `SimilaritySettings`; add `SimilarityGraph` type.
2. `src/constants.ts` — add `graph` defaults to `DEFAULT_SETTINGS`.
3. `src/app/buildSimilarityGraph.ts` — **new** thin orchestration use case (§4).
4. `src/appContainer.ts` — instantiate `makeBuildSimilarityGraph` and expose it.
5. `src/ui/SemanticGraphView.ts` — **new** `ItemView`: canvas + d3-force + interactions.
6. `src/ui/graph/` (suggested) — split helpers: `ForceSimulation.ts`, `GraphRenderer.ts`
   (canvas draw + pan/zoom + hit-test), `GraphControlsPanel.ts` (cog overlay DOM).
7. `src/app/activateGraphView.ts` — **new** (or generalize `activateRightLeafView`) to open
   the view in a main/center leaf.
8. `main.ts` — `registerView`, `registerHoverLinkSource`, add command + ribbon icon, refresh
   on relevant events.
9. `styles.css` — controls-panel layout, canvas container; rely on `--graph-*` variables for
   colors. No hardcoded palette.
10. `manifest.json` / `versions.json` — version bump per existing release flow.

---

## 8. Edge cases & states to handle

- **Empty / no index:** show "Build index" affordance (reuse `startOrRefreshIndexSync`), not
  an empty canvas.
- **Indexing in progress:** progress banner + recompute when indexing settles (subscribe to
  indexing state, debounced — mirror `SimilarNotesListView`).
- **Single / zero edges above threshold:** node appears as an orphan; respect the Orphans
  toggle.
- **Directional asymmetry:** A's top-N may include B while B's doesn't include A. Default to
  **undirected, deduped** edges; weight = `max(scoreAB, scoreBA)`. (Optionally offer an
  "Arrows / directed" toggle later.)
- **Ignored / non-markdown notes:** exclude via `isIgnoredPath` and the markdown check.
- **Renames/deletes:** `indexRepo.rename`/`remove` already keep IDs (paths) current;
  recompute on indexing-state change picks these up.
- **Large vaults:** node cap (e.g. warn / sample beyond ~2–3k nodes), chunked build with
  progress, quadtree hit-testing, throttle the simulation when offscreen/closed.
- **Theme switch:** re-read CSS variables on `css-change`.
- **Teardown:** stop the simulation, cancel RAF, disconnect `ResizeObserver`, remove
  listeners in `onClose()`.

---

## 9. Decisions to confirm before coding

1. **Edge build location** — recommended: new `makeBuildSimilarityGraph` app use case
   (architecture-correct). Alternative: loop `getSimilarNotes` from the UI (violates
   `AGENT.md`). **Recommend the app use case.**
2. **Simulation library** — recommended: add `d3-force`. Alternative: hand-rolled physics
   (no dependency, more code/risk).
3. **N location** — in-view cog panel (matches Obsidian) **and** persisted to settings.
   Confirm default N (proposed: 5) and whether to also expose a minimum-similarity slider.
4. **Scope of MVP** — global graph + controls panel + core interactions first; local-graph
   (depth) and time-lapse animation as stage 2.

---

## 10. Verification

- `npm run build` passes (tsc + esbuild), per `AGENT.md` quality gate.
- Architecture check: domain untouched; UI calls only use cases/ports; new orchestration in
  `app`; composition in `AppContainer`. No `--graph-*` color hardcoding.
- Manual: open the view on a populated vault → nodes render, edges = top-N, N slider changes
  edge density live, forces sliders affect layout, hover highlights neighbours, click opens
  the note, right-click shows the file menu, theme switch recolors the canvas, view tears
  down cleanly (no leaked RAF/listeners — check with repeated open/close).

---

## Sources

- [Graph view — Obsidian Help](https://obsidian.md/help/plugins/graph)
- [Views — Obsidian Developer Documentation](https://docs.obsidian.md/Plugins/User+interface/Views)
- [Graph CSS variables — Obsidian Developer Documentation](https://docs.obsidian.md/Reference/CSS%20variables/Plugins/Graph)
- [Graph view customization — Obsidian Hub](https://publish.obsidian.md/hub/04+-+Guides,+Workflows,+&+Courses/Guides/Graph+view+customization)
- Internal: `AGENT.md`, `src/appContainer.ts`, `src/app/getSimilarNotes.ts`,
  `src/ui/SimilarNotesListView.ts`, `src/app/activateRightLeafView.ts`, `src/types.ts`,
  `src/constants.ts`
