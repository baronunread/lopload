// Thin wrapper around the Rust keychain commands (PLAN.md #4). Credentials
// never touch SQLite or a plaintext file — only the OS keychain, via these
// three Tauri invokes.

import { invoke } from "@tauri-apps/api/core";

import type { Credentials } from "../lib/types";

export async function keychainSet(
  connectionId: string,
  credentials: Credentials,
): Promise<void> {
  await invoke("keychain_set", {
    connectionId,
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
  });
}

export async function keychainGet(connectionId: string): Promise<Credentials | null> {
  return invoke<Credentials | null>("keychain_get", { connectionId });
}

export async function keychainDelete(connectionId: string): Promise<void> {
  await invoke("keychain_delete", { connectionId });
}
