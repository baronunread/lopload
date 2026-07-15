// TypeScript 7's bundler module resolution skips `bun:test` because it looks
// like an absolute URI (the `:` after `bun`). Re-export the declarations from
// bun-types so tsc --noEmit can resolve it.
/// <reference types="bun-types" />
