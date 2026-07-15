// The node:fs implementations of the engine's LocalFileReader/LocalFileWriter,
// re-exported as one import for the Node host. These satisfy exactly the same
// contracts as src/tauri/fs.ts — the engine can't tell them apart, which is the
// point: uploads read real bytes off disk and downloads write real bytes to it.
export { localFileReader } from "./localFileReader";
export { localFileWriter } from "./localFileWriter";
