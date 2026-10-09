# GPUIX todo app

A small todo app that renders on the GPU. Create a copy with the GPUIX CLI.

```bash
bunx @gpuix/cli new my-app
cd my-app
bun run dev
```

`dev` runs `bun --hot app.tsx`. A save remounts React on the same window.

## Scripts

| Script | What it does |
|---|---|
| `bun run dev` | Start the desktop app with hot remount |
| `bun run build` | Compile a standalone binary into `dist/todo` |
| `bun run test` | Drive the app through the GPU test renderer with Vitest |
| `bun run typecheck` | Run `tsc --noEmit` |
| `bun run web:dev` | Bundle for the browser and serve on `:4173` |
| `bun run screenshot` | Drive the app with the automation client and write a PNG |

The browser renderer ships inside `@gpuix/native`, so `web:dev` needs no Rust.
Inside the GPUIX repository `packages/native/wasm/` is gitignored; build it once
with `bun run build:web` in `packages/native`.

## Files

```
app.tsx        the whole app: tokens, icons, data, components, screen
app.test.tsx   drives the app in-process through the GPU test renderer
index.html     the browser page. GPUI creates the canvas itself
web.ts         bundles app.tsx and serves it with isolation headers
screenshot.ts  drives the app with the automation client and writes a PNG
assets/icons   lucide SVGs, imported as text and tinted with style.color
assets.d.ts    tells TypeScript that a `.svg` import is a string
```

## What it shows

- **`<virtual-list>`** for the task list. GPUI builds only the visible rows plus
  overdraw. React still mounts every child, so a list of thousands should also
  pass `itemCount` and `windowStart` and render just that window
- **native `<input>`** in the composer, with a caret, IME, and clipboard
- **`motion.div`** for the sidebar, animated in Rust with no React frames
- **`<svg>`** icons tinted through `style.color`
- **`hover` and `active`** styles applied natively, with no JavaScript round trip
- **`testId`** props, so the automation client can drive the app

## Testing

`app.test.tsx` mounts `TodoApp` on the GPU test renderer and drives it with the
same locator API as `screenshot.ts`, but in-process:

```tsx
const { render, renderer } = createTestRoot({ width: 940, height: 660 })
render(<TodoApp />)
const app = await connectTest(renderer)

await app.getByTestId('row-t5').hover()
await app.getByTestId('delete-t5').click()
expect(renderer.getPaintedText()).not.toContain('Animate the sidebar with motion.div')
```

`render()` at the bottom of `app.tsx` sits behind an entry-point check, so
importing the file does not open a window. `getPaintedText()` returns every
string painted last frame; the trash button only exists while the row is
hovered, so `hover()` comes first.

## Create a standalone copy

The CLI downloads this folder and replaces its workspace dependency with the
latest published `@gpuix/react` version:

```bash
bunx @gpuix/cli new my-app
```

Nothing else in the folder depends on the repository.

## Two rules that are easy to miss

**Set `jsxImportSource`.** Without it TypeScript uses DOM types and every GPUIX
element fails:

```json
{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "@gpuix/react" } }
```

**Set a `color` on text.** GPUI does not inherit `color`, so a `<text>` with no
color paints black and disappears on a dark surface.

## Fonts on the web

The browser build ships **IBM Plex Sans** and **Lilex** only. Any other family
falls back to Lilex, which is a monospace, so `app.tsx` picks the family per
target:

```tsx
const FONT = typeof window === 'undefined' ? 'Helvetica' : 'IBM Plex Sans'
```

## Cross-origin isolation

The Wasm renderer uses shared memory. `web.ts` sends the two headers a
production host also needs:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
