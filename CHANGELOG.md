# Changelog

## Unreleased

### Features

- MCP live desktop mode — `openpencil-mcp --app desktop` can now proxy tool calls into an already opened OpenPencil desktop app instance through the local automation bridge
- Figma-targeted export — new `Export for Figma…` action and CLI `bun open-pencil export file.fig --format fig --target figma` generate a Figma-oriented `.fig` that flattens layout/component semantics for better import fidelity without changing OpenPencil’s native save format

### Improvements

- Split local and CI Tauri config — local `bun run tauri ...` now uses the base unsigned config with an optional untracked `desktop/tauri.local.conf.json` override, while GitHub builds layer `desktop/tauri.ci.conf.json` for signing-only settings
- Dirty document close guard — closing a tab or app window with unsaved `.fig` changes now asks whether to save, discard, or cancel before the document is closed
- Desktop startup restore — the app now reopens the most recently used `.fig` file on launch when starting into a fresh untitled tab

## 0.8.0 — 2026-03-07

### Features

- Mobile layout & PWA — responsive editor with touch-optimized toolbar, swipeable bottom drawer (layers/properties/design/code), HUD overlay, and installable PWA with icons and service worker
- AI screenshot capture — new `take_screenshot` tool lets the built-in agent capture the current page, selection, or explicit nodes for visual comparison against reference attachments, with a screenshot-style shimmer highlight in the editor during capture
- Tailwind CSS v4 JSX export — export selections as HTML with Tailwind utility classes (`<div className="flex gap-4 p-3">`) from the Code panel, CLI (`bun open-pencil export --format jsx --style tailwind`), or programmatically via `sceneNodeToJSX(id, graph, 'tailwind')`. Supports layout, sizing, colors, border radius, opacity, rotation, overflow, shadows, blur, and typography. Uses v4 spacing semantics (px/4 multiplier) with automatic fallback to arbitrary values.
- Code panel format toggle — switch between OpenPencil (custom components) and Tailwind (HTML + utility classes) output
- AI chat attachments — attach local files in the composer and paste clipboard images directly into the built-in chat for multimodal prompts
- Direct OpenAI Codex backend — the built-in chat now supports provider-aware model routing, with curated OpenRouter models plus direct OpenAI Codex selection
- Desktop CLI backends — experimental Claude Code CLI and Codex CLI sessions can now drive the built-in chat through desktop bridge-backed OpenPencil tool calls, including real-time response/tool streaming, JSX `render` via a staged helper script, and stop/cancel support
- Homebrew tap — `brew install open-pencil/tap/open-pencil` for macOS (arm64 + x64), auto-updated on each release
- Double-click to rename layers — inline rename in layer panel, shared `useInlineRename` composable
- New AI/MCP tools: `analyze_colors`, `analyze_typography`, `analyze_spacing`, `analyze_clusters`, `diff_create`, `diff_show`, `get_components`, `get_current_page`, `arrange`, `node_to_component`
- CLI-to-app RPC bridge — all CLI commands work against the running app when no file is specified. Start the app, then run `bun open-pencil tree` to inspect the live document
- VitePress docs site — user guide, reference, architecture, and development docs at openpencil.dev with 6 locales (en, de, fr, es, it, pl), SEO (OG tags, hreflang, JSON-LD, sitemap), and dark theme

### Improvements

- File menu now includes Open Recent on desktop, backed by a persisted local list of recently opened or saved `.fig` files
- Refactor mobile drawer tabs, layout sizing dropdowns, and inline rename to use Reka UI primitives
- AI model selector groups models by integration (Codex CLI, Claude Code CLI, OpenAI, Open Router) and exposes per-CLI model variants
- AI chat prompt history — submitted prompts are stored locally and can be recalled in the composer with ↑/↓
- AI chat history restore — prior conversations are restored locally when reopening the app or reloading the editor
- AI chat drag-and-drop — files can now be dropped directly onto the composer to attach them to the next prompt, with a visible drop target state
- Native CLI session continuity — Claude Code CLI and Codex CLI now continue their own session history between turns, lock the model picker to the active CLI backend on restore, and expose a New session reset in the chat UI
- Add shared UI style helpers with tailwind-variants for menus, selects, buttons, and surfaces
- Unified tool definitions — define once in `packages/core/src/tools/`, automatically available in AI chat, CLI, and MCP
- Harden FigmaAPI — hide internals via Symbols, freeze arrays, fix `layoutSizing`, 30+ new properties and methods
- Split tools into domain files (read, create, modify, structure, variables, vector, analyze) — easier to navigate and extend
- Replace inline type definitions with named types (`Color`, `Vector`, `SceneNode`) across the codebase
- Split 3200-line `renderer.ts` into `packages/core/src/renderer/` with 10 focused files (scene, overlays, fills, strokes, shapes, effects, rulers, labels)
- Centralize all color utilities in `packages/core/src/color.ts` — `colorToHex8`, `colorToCSSCompact`, `normalizeColor`, `colorDistance`; remove 5 duplicate implementations across the codebase
- Add `geometry.ts` with shared rotation math (`degToRad`, `radToDeg`, `rotatePoint`, `rotatedCorners`, `rotatedBBox`)
- Extract `isArrayMixed()` helper for multi-selection property panels

### Fixes

- Fix Figma-target font style serialization — exported `.fig` files now write Figma-compatible style names like `Regular`, `Semi Bold`, and `Extra Bold` instead of OpenPencil’s internal compact names, reducing missing/ignored text on Figma import
- Fix desktop CLI backend discovery on macOS and Windows app launches — Codex CLI and Claude Code CLI now resolve binaries from common user/Homebrew/npm install paths even when the app PATH is limited
- Fix AI chat attachment submission — pasted images and attached files now normalize to SDK file parts before send, and Codex CLI temp-directory runs skip the git repo trust check
- Improve AI chat transcript structure — assistant text is now split around tool activity instead of being merged into one block, and live thinking steps appear inline while the response is still being generated
- Reduce screenshot attachment overhead — pasted/uploaded images are downscaled and recompressed before send, and restored chat history now stores lightweight attachment placeholders instead of raw base64 image payloads
- Fix restored CLI chat sessions on first open/reply — stored chat history is now normalized on load, chat initialization is deferred until the AI panel is actually opened, and assistant transcript text renders without the unstable markdown parser that was causing runtime toasts on restore
- Fix desktop CLI chat progress — Codex now runs with bridge-capable local access, Claude/Codex use structured streaming for partial assistant output, and the chat no longer replays internal CLI shell steps as user-facing tool calls
- Fix Codex progress parsing — the chat now accepts current Codex JSONL `item_type` / `assistant_message` event variants so interim technical status text does not disappear from the transcript
- Fix desktop automation bridge ownership in Tauri dev — the Vite dev server now skips its local bridge when launched via `bun run tauri dev`, avoiding the `127.0.0.1:7600` port collision and false “OpenPencil app is not connected” tool failures
- Fix desktop Open Recent watcher errors — reopened files now continue loading even if filesystem watch setup fails, and Tauri watch permission scope explicitly allows reopening files outside the app bundle
- Fix drawer animation jump on close — single spring transition instead of two-phase
- Fix `ALL_TOOLS` registry missing newer tools (`analyzeColors`, `diffCreate`, `exportImage`, `arrangeNodes`)
- Fix `renderJSX` typo in tool definitions (`renderJsx` → `renderJSX`)
- Fix all oxlint warnings and tsgo errors — replace `!` non-null assertions in `use-collab.ts` with local const captures
- Fix broken test imports — stale `../../src/engine/` paths updated to `@open-pencil/core`
- Fix flaky E2E tests: layers panel navigates to `/demo`, zoom-to-fit test zooms in first, snapshot rendering stabilized with `workers: 1` and `colorScheme: dark`
- Fix bogus .fig import mappings for `expanded` and `strokeMiterLimit` fields
- Fix PWA manifest error in dev mode, handle invalid font data gracefully
- Fix eval response unwrapping and `export_jsx` page selection in RPC bridge
- Fix automation commands not recomputing layouts after mutations
- Fix workspace dependency not resolved when installing from npm (switch CI to pnpm publish)

### Internal

- Add `motion-v` for declarative animations — used in mobile drawer (spring-animated height with pan gestures) and toolbar (layout-animated category switching with directional slide transitions)
- Mobile drawer: replace `useSwipe` + manual rAF animation with `motion.div` `:animate` + `@pan`/`@panEnd`; always-on tab state (no more null `activeRibbonTab`); content stays rendered when closed
- Mobile toolbar: replace manual `scrollWidth` measuring + inline CSS transitions with `motion.div layout` + `AnimatePresence` directional slide variants
- Mobile UI cleanup: extract shared `colorToCSS` util to core, `initials` to `src/utils/text`, `toolIcons` to `src/utils/tools`; replace hand-rolled dropdowns with reka-ui Popover/DropdownMenu; narrow `mobileDrawerSnap` type to string union; move magic numbers to constants; disable PWA service worker in dev mode
- 83 new E2E tests (57 → 140): design panel, code panel, components, copy/paste, multi-page, text editing, keyboard shortcuts, context menu
- 150 new unit tests (588 → 738): color, undo, snap, vector, style-runs, text-editor
- 48 new E2E tests (9 spec files) + 26 mutation unit tests + store/canvas test helpers
- Add `data-test-id` attributes to AppearanceSection, LayoutSection, TypographySection, VariablesDialog, EditorView

## 0.7.0 — 2026-03-05

### Features

- SVG export — export selections as SVG from the export panel, context menu, CLI (`bun open-pencil export --format svg`), or MCP/AI tools (`export_svg`). Supports rectangles, ellipses, lines, stars, polygons, vectors, text with style runs, gradients, image fills, effects, blend modes, clip paths, and nested groups (#46)
- Copy/Paste as submenu in context menu — Copy as text, Copy as SVG, Copy as PNG (⇧⌘C), Copy as JSX
- Stroke align (Inside/Center/Outside) with clip-based rendering matching Figma behavior
- Individual stroke weights per side (Top/Right/Bottom/Left) with side selector dropdown
- Google Fonts fallback — automatically loads fonts from Google Fonts API when not available locally
- Auto-save toggle in File menu — disable to prevent automatic writes to the opened .fig file
- Renderer profiler with in-canvas HUD overlay, GPU timing, and phase instrumentation

### Improvements

- Replace custom color picker with Reka UI Color components (ColorArea, ColorSlider, ColorField) — adds keyboard navigation and accessibility to the color area, hue, and alpha controls

### Fixes

- CJK text rendering — load a system CJK font (PingFang SC, Microsoft YaHei, Noto Sans CJK) as fallback; falls back to Noto Sans SC from Google Fonts when no system font is available (#48)
- Font registration errors no longer cache invalid font data — `loadFont` only caches after successful CanvasKit registration
- Fix `render` tool failing on Windows + Bun with "Cannot find module" error (#43)
- Fix hover highlighting nodes from internal component pages — scope hit-test to current page
- Fix hit-testing on transparent frames and groups — empty containers without fills or strokes are now click-through, clipping parents reject hits outside their bounds, matching Figma behavior
- Fix instance overrides on .fig import and clipboard paste — resolve guidPaths by overrideKey, handle component swaps (`overriddenSymbolID`), propagate through nested clone chains. Import and paste now share a single override engine.
- Apply Figma component property assignments on import — boolean visibility toggles and instance swaps via `componentPropRefs`/`componentPropAssignments`
- Apply `derivedSymbolData` sizes on import — containers now shrink correctly when component properties hide children
- Fix override resolution for nested instance targets — check the current node before searching descendants
- Fix component property assignments for nested instances — resolve scoped `componentPropAssignments` inside `symbolOverrides` via guidPath, handle `guidValue` for instance swaps, reorder phases so transitive sync doesn't clobber visibility
- Pixel-perfect vector rendering using pre-computed `fillGeometry`/`strokeGeometry` blobs from .fig files — eliminates white gaps between adjacent stroked shapes
- Stroke outlines on clipboard paste — convert vectorNetwork paths to filled outlines via CanvasKit when geometry blobs are unavailable
- Apply `derivedSymbolData` transforms and geometry during import — instance children render at correct scale and position
- Fix internal pages becoming visible after .fig round-trip — preserve `internalOnly` flag on export
- Scope layout recomputation to current page for paste/undo/font-load (major speedup on large multi-page files)
- Show loading overlay until all document fonts are loaded (no more partially rendered text)
- Load fonts when switching pages (previously only loaded for the first page)
- Always show visibility toggle on fill, stroke, and effect rows (matches Figma)
- Fix renderer crash on double destroy when closing files quickly
- Fix .fig page ordering — use deterministic byte comparison for fractional index positions
- Fix text truncation using `textTruncation` field instead of `textAutoResize`
- Fix horizontal scrollbar on design and pages panels
- Style scrollbars for Tauri (thin dark overlay instead of default OS chrome)
- Enable file watcher in Tauri — `watch` feature was missing from `tauri-plugin-fs`

## 0.6.0 — 2026-03-04

### Features

- Multi-selection properties panel — edit position, size, appearance, fill, stroke, and effects across multiple selected nodes
- Shared values display normally, differing values show "Mixed"
- W/H inputs in multi-selection mode
- Flip horizontal/vertical using scale transform instead of rotation
- Single-node alignment aligns to parent frame bounds
- ACP agent package — Agent Communication Protocol server for AI coding tools, reusing core ToolDefs

### Build

- Apple code signing and notarization for macOS builds
- Git LFS storage moved from GitHub to Cloudflare R2


### Fixes

- Fix Figma clipboard paste: extract shared kiwi→SceneNode conversion, fixing broken auto-layout, missing gradient/image fills, effects, style runs, and text properties
- Fix vector rendering on paste — scale path coordinates from Figma's normalizedSize to actual node bounds
- Fix pasted instances having no children — populate from component via symbolData when both are in clipboard
- Detect component sets on import — promote FRAME nodes with VARIANT componentPropDefs to COMPONENT_SET
- Skip internal canvas on paste — components on Figma's hidden internal page populate instances but are not pasted as visible nodes
- Apply instance overrides on paste — text content, fills, visibility, layoutGrow, and textAutoResize from symbolOverrides
- Fix auto-layout child ordering — sort by geometric position instead of z-order position strings
- Load fonts on paste and .fig import — collect font families from text nodes and load into CanvasKit
- Text measurement in auto-layout — use CanvasKit paragraph metrics for WIDTH_AND_HEIGHT text nodes
- Recompute layouts after font loading completes
- Fix PERCENT line height conversion — was stored as raw value instead of pixels
- Fix InvalidCharacterError when copying nodes with non-ASCII text
- Load all font weight/style variants needed by pasted text nodes
- Fix font loading not registering in core cache
- Fix halfLeading applied to text measurement — enable only for rendering
- Clear hover on zoom/pinch to keep scene picture cache valid
- Fix flip buttons using rotation math instead of actual mirroring
- Fix flip transform encoding — scale first matrix column only (was incorrectly producing 180° rotation)
- Decode flip state from .fig transform matrix on import

## 0.5.1 — 2026-03-03

### Fixes

- Fix File → Save crash when document has layer blur effects

## 0.5.0 — 2026-03-03

### Features

- Effects rendering: drop shadow, inner shadow, shadow spread, layer blur, background blur, foreground blur
- Text shadows render on glyphs instead of bounding box
- Multi-file tabs — open multiple documents in tabs within a single window
- Tab bar with close buttons, middle-click to close, and new tab (+) button
- Keyboard shortcuts: ⌘N/⌘T new tab, ⌘W close tab, ⌘O opens in new tab
- Native Tauri menu: File → New and File → Close Tab wired to tab actions
- Render text from SkPicture cache when fonts are missing — pixel-perfect display without the font installed
- Missing font indicator (⚠) next to font picker in the sidebar
- Right-click context menu on layers panel — same actions as the canvas context menu
- 40+ new AI/MCP tools ported from figma-use:
  - Granular set tools: `set_rotation`, `set_opacity`, `set_radius`, `set_minmax`, `set_text`, `set_font`, `set_font_range`, `set_text_resize`, `set_visible`, `set_blend`, `set_locked`, `set_stroke_align`
  - Node operations: `node_bounds`, `node_move`, `node_resize`, `node_ancestors`, `node_children`, `node_tree`, `node_bindings`, `node_replace_with`
  - Variable CRUD: `get_variable`, `find_variables`, `create_variable`, `set_variable`, `delete_variable`, `bind_variable`
  - Collection CRUD: `get_collection`, `create_collection`, `delete_collection`
  - Boolean operations: `boolean_union`, `boolean_subtract`, `boolean_intersect`, `boolean_exclude`
  - Vector path tools: `path_get`, `path_set`, `path_scale`, `path_flip`, `path_move`
  - Create tools: `create_page`, `create_vector`, `create_slice`
  - Viewport: `viewport_get`, `viewport_set`, `viewport_zoom_to_fit`, `page_bounds`
  - Misc: `flatten_nodes`, `list_fonts`
- `set_text_properties` tool: alignment, auto-resize, decoration
- `set_layout_child` tool: sizing, grow, align_self, positioning
- 13 MCP server integration tests via `InMemoryTransport`

### UI

- Resizable pages/layers split in left panel with reka-ui Splitter
- Layers tree auto-expands and scrolls to reveal selected node
- Loading overlay on canvas while opening .fig files
- Hide internal-only pages (e.g. "Internal Only Canvas" in design systems)
- Render page dividers — pages named with only dashes/asterisks/spaces show as horizontal lines
- Only show component labels for COMPONENT and COMPONENT_SET, not instances
- Replace all native `<select>` dropdowns with reka-ui `AppSelect` component
- Smoother trackpad pinch-to-zoom with `Math.exp` curve and deltaMode normalization
- Fix font picker dropdown truncating long font names
- Show explanation in font picker when Local Font Access API unavailable (Safari/Firefox)

### Fixes

- Fix drop shadow rendering on top of fills — shadow now draws behind opaque content
- Fix effect property changes not recorded in undo/redo history
- Fix active tab text invisible against same-color background
- Fix clipboard "Outside int range" error — `pasteID` used unsigned int exceeding Kiwi's signed 32-bit field
- Error toasts are now sticky (don't auto-dismiss), with selectable text, copy button, and close button
- Truncate long node names in export button

### Performance

- Per-node SkPicture cache for effect rendering — unchanged shadow/blur nodes replay from cache on scene redraws
- Drop shadows use `MaskFilter` direct draw instead of `saveLayer` offscreen buffers
- Cached `ImageFilter`, `MaskFilter`, reusable effect paint — zero per-frame WASM allocations for effects
- Reuse GL context on panel resize — swap surface without recreating renderer, preserving all caches
- Per-frame absolute position cache — avoids repeated parent-chain walks during rendering
- Optimize zoom/pan smoothness with `shallowReactive`, `useRafFn`, and input coalescing

### Build

- Auto-populate GitHub Release notes from CHANGELOG.md via `ffurrer2/extract-release-notes@v2`
- Skip already-published npm versions on CI re-runs instead of failing
- Exclude non-app directories from Vite file watcher

### Internal

- Extract shared color constants (`BLACK`, `TRANSPARENT`, `DEFAULT_SHADOW_COLOR`) — replaces 8 inline literals across core
- Extract shared `NodeContextMenuContent` component to avoid menu duplication
- Fix `@open-pencil/core` dep in MCP package: `workspace:*` for local dev (pnpm resolves at publish time)
- Replace store thunks with a late-binding proxy

### Tests

- Clipboard roundtrip tests: encode to Figma Kiwi binary → decode → verify
- 9 visual regression snapshot tests for effects rendering
- Zoom/pan E2E tests and pipeline benchmark
- MCP server edge-case tests for `find_nodes` and Zod validation
- 6 unit tests for absolute position cache

## [0.4.2] (2026-03-02)

### Fixes

- Fix Figma clipboard paste: skip non-visual node types (variables, widgets, stickies, connectors)
- Fix text not rendering after paste — `letterSpacing` from Figma is a `{value, units}` object, was passed as-is → `NaN` broke CanvasKit paragraph layout
- Fix undo/redo for Figma paste — no undo entry was recorded; redo duplicated `childIds`
- Center pasted Figma content in viewport instead of using original coordinates
- Compute auto-layouts after clipboard paste (same as .fig import and demo creation)

### Improvements

- Import additional properties from Figma clipboard: `layoutAlignSelf`, `clipsContent`, `fontWeight`, `italic`, `letterSpacing`, `lineHeight`
- Convert `letterSpacing` PERCENT units to pixels based on font size

### Tests

- 7 new clipboard import unit tests (14 total)

## [0.4.1] (2026-03-02)

### Fixes

- Fix text disappearing after hover when SkPicture cache was recorded before fonts loaded
- Invalidate scene picture cache on font load to prevent stale fallback text

### Docs

- Highlight copy & paste with Figma in README and feature docs
- Replace "fig-kiwi" format name with "Kiwi binary" — the format is shared between .fig files and clipboard

## [0.4.0] (2026-03-02)

### Features

- MCP server (`@open-pencil/mcp`) — 29 tools for headless .fig editing via stdio (Claude Code, Cursor, Windsurf) or HTTP (Hono + Streamable HTTP with sessions)
- `openpencil-mcp` and `openpencil-mcp-http` binaries — install globally via `bun add -g @open-pencil/mcp`

### Build

- All packages emit JS via tsgo + fix-esm-import-path — `@open-pencil/core` and `@open-pencil/mcp` work on Node.js without Bun
- Core package exports: `bun` condition → src (dev), `import` condition → dist (npm consumers)
- `@open-pencil/mcp` added to CI publish workflow

## [0.3.2] (2026-03-02)

### Performance

- Re-apply SkPicture scene caching for ~7x faster pan/zoom (0.98ms vs 6.8ms per frame at 500 nodes)

### Tests

- Visual regression tests for SkPicture cache: hover on/off cycle, multiple cycles, mouse hover, scene change + hover
- Type `window.__OPEN_PENCIL_STORE__` globally, remove ad-hoc casts from tests

## [0.3.1] (2026-03-02)

### Fixes

- Fix text disappearing after hovering a frame (revert SkPicture scene caching)
- Fix macOS startup hang: async font loading, show window on reopen

## [0.3.0] (2026-03-01)

### Performance

- SkPicture scene caching — pan/zoom replays cached display list instead of re-rendering all nodes
- Cache vector network paths — avoid rebuilding WASM paths every frame
- Cache ruler and pen overlay paints — eliminate 10 WASM Paint allocations per frame
- Only enable `preserveDrawingBuffer` in test mode
- Hoist URL param parsing out of render loop

### Fixes

- Fix npm publish: use pnpm for workspace dependency resolution with provenance
- CLI version now reads from package.json instead of hardcoded value
- Update README: accurate app size (~7 MB), streamlined feature list, current project structure

## [0.2.1] (2026-03-01)

### UI

- Panel header with app logo, editable document name, and sidebar toggle
- ⌘\\ to toggle side panels for distraction-free canvas
- Panels hidden by default on mobile (< 768px)
- Floating bar with logo, filename, and restore button when panels hidden
- Always show local user avatar in collab header
- Touch support for pan and pinch-zoom on iOS

### Performance

- Stubbed shiki to remove 9MB of unused language grammars (20MB → 11MB bundle)

## [0.2.0] (2026-03-01)

### Collaboration

- Real-time P2P collaboration via Trystero (WebRTC) + Yjs CRDT
- Peer-to-peer sync — no server relay, zero hosting cost
- WebRTC signaling via MQTT public brokers
- STUN (Google, Cloudflare) + TURN (Open Relay) for NAT traversal
- Awareness protocol: live cursors, selections, presence
- Figma-style colored cursor arrows with name pills
- Click peer avatar to follow their viewport, click again to stop
- Stale cursor cleanup on peer disconnect
- Local persistence via y-indexeddb — room survives page refresh
- Share link at `/share/<room-id>` with vue-router
- Secure room IDs via `crypto.getRandomValues()`
- Removed Cloudflare Durable Object relay server (`packages/collab/`)

### UI

- Toast notifications via Reka UI Toast — top-center blue pill for info, red for errors
- Global error handler (window.error + unhandledrejection) shows errors as toasts
- Link copied toast on share and copy link actions
- HsvColorArea extracted as shared component (ColorPicker + FillPicker)
- Scrollable app menu without visible scrollbar
- Selection broadcasting to remote peers

## [0.1.0-alpha] (2026-03-01)

First public alpha. The editor is functional but not production-ready.

### Editor

- Canvas rendering via CanvasKit (Skia WASM) on WebGL surface
- Rectangle, Ellipse, Line, Polygon, Star drawing tools
- Pen tool with vector network model (bezier curves, open/closed paths)
- Inline text editing on canvas with phantom textarea for input/IME
- Rich text formatting: bold, italic, underline per-character via style runs
- Font picker with system font enumeration (font-kit on desktop, Local Font Access API in browser)
- Auto-layout via Yoga WASM (direction, gap, padding, justify, align, child sizing)
- Components, instances, component sets with live sync and override preservation
- Variables with collections, modes, color bindings, alias chains
- Undo/redo for all operations (inverse-command pattern)
- Snap guides with rotation-aware edge/center snapping
- Canvas rulers with selection range badges
- Marquee selection, multi-select, resize handles, rotation
- Group/ungroup, z-order, visibility, lock
- Sections with title pills and auto-adoption of overlapping nodes
- Multi-page documents with independent viewport state
- Hover highlight following node geometry (ellipses, rounded rects, vectors)
- Context menu with clipboard, z-order, grouping, component, and visibility actions
- Color picker with HSV, gradients (linear, radial, angular, diamond), image fills
- Properties panel: position, appearance, fill, stroke, effects, typography, layout, export
- ScrubInput drag-to-change number controls
- Resizable side panels via reka-ui Splitter

### File Format

- .fig file import via Kiwi binary codec (194 definitions, ~390 fields)
- .fig file export with Kiwi encoding, Zstd compression, thumbnail generation
- Figma clipboard: copy/paste between OpenPencil and Figma
- Round-trip fidelity for supported node types

### AI Integration

- Built-in AI chat in properties panel (⌘J)
- Direct browser → OpenRouter communication, no backend
- Model selector: Claude, Gemini, GPT, DeepSeek, Qwen, Kimi, Llama
- 10 AI tools: create_shape, set_fill, set_stroke, update_node, set_layout, delete_node, select_nodes, get_page_tree, get_selection, rename_node
- Streaming markdown responses (vue-stream-markdown)
- Tool call timeline with collapsible details

### Code Panel

- JSX export of selected nodes with Tailwind-like shorthand props
- Syntax highlighting via Prism.js
- Copy to clipboard

### CLI (`@open-pencil/cli`)

- `info` — document stats, node types, fonts
- `tree` — visual node tree
- `find` — search by name/type
- `export` — render to PNG/JPG/WEBP at any scale
- `node` — detailed properties by ID
- `pages` — list pages with node counts
- `variables` — list design variables and collections
- `eval` — run scripts with Figma-compatible plugin API
- `analyze colors` — color palette usage
- `analyze typography` — font/size/weight distribution
- `analyze spacing` — gap/padding values
- `analyze clusters` — repeated patterns
- All commands support `--json`

### Core (`@open-pencil/core`)

- Scene graph with flat Map storage and parentIndex tree
- FigmaAPI with ~65% Figma plugin API compatibility
- JSX renderer (TreeNode builder functions with shorthand props)
- Kiwi binary codec (encode/decode)
- Vector network blob encoder/decoder

### Desktop App

- Tauri v2 (~5 MB)
- Native menu bar, save/open dialogs
- System font enumeration via font-kit
- Zstd compression in Rust
- macOS and Windows builds via GitHub Actions

### Web App

- Runs at [app.openpencil.dev](https://app.openpencil.dev)
- No installation required
- File System Access API for save/open (Chrome/Edge), download fallback elsewhere

### Documentation

- [openpencil.dev](https://openpencil.dev) — VitePress site with user guide, reference, and development docs
- Deployed via Cloudflare Pages
