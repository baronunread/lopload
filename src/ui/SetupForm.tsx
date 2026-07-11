import { useEffect, useState } from "react";
import { Button, Input, SensitiveInput, useKumoToastManager } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";
import type { ConnectionDraft } from "./services";
import { useServices } from "./services";

export interface SetupFormProps {
  /** Connection being edited, if this is "Add storage" from an existing list. */
  existing?: Connection;
  onSaved: (conn: Connection) => void;
  /**
   * Floor on how long the "testing" state is shown, so a test that resolves
   * near-instantly (e.g. against a local/mocked endpoint) still reads as
   * having actually done something. Defaults to MIN_TEST_DURATION_MS;
   * overridable in tests so they don't have to wait it out.
   */
  minTestDurationMs?: number;
}

/** Default floor for how long "Testing…" stays visible — see SetupFormProps.minTestDurationMs. */
export const MIN_TEST_DURATION_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FormState {
  name: string;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  endpoint: "",
  accessKey: "",
  secretKey: "",
  bucket: "",
  region: "",
};

/**
 * The storage connection form: fields + the test-then-save morphing submit
 * button (with a shake on failure). Used both inside the first-run
 * onboarding flow and inside AddStorageDialog. The field that maps to
 * Connection.bucket is labeled "Storage name"; its description is the one
 * place the app says "bucket", bridging to the provider console the user
 * is copying values from — everywhere else the app avoids S3 jargon.
 */

/** The single sanctioned use of the word "bucket" in the app. The
 *  jargon-sweep test strips exactly this string before scanning, so any
 *  other occurrence anywhere still fails. */
export const STORAGE_NAME_BRIDGE =
  "Your provider's console calls this the bucket name.";
export function SetupForm({
  existing,
  onSaved,
  minTestDurationMs = MIN_TEST_DURATION_MS,
}: SetupFormProps) {
  const services = useServices();
  const [form, setForm] = useState<FormState>(
    existing
      ? {
          name: existing.name,
          endpoint: existing.endpoint,
          accessKey: "",
          secretKey: "",
          bucket: existing.bucket,
          region: existing.region ?? "",
        }
      : EMPTY_FORM,
  );
  const [testState, setTestState] = useState<"idle" | "testing" | "passed" | "failed">(
    "idle",
  );
  const [saving, setSaving] = useState(false);
  const [shake, setShake] = useState(false);
  const toasts = useKumoToastManager();

  useEffect(() => {
    if (!shake) return;
    const timer = setTimeout(() => setShake(false), 400);
    return () => clearTimeout(timer);
  }, [shake]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    // Any edit invalidates a prior successful test — re-test before saving.
    setTestState("idle");
  }

  function draft(): ConnectionDraft {
    return {
      name: form.name,
      endpoint: form.endpoint,
      accessKey: form.accessKey,
      secretKey: form.secretKey,
      bucket: form.bucket,
      region: form.region || undefined,
    };
  }

  async function handleTest() {
    setTestState("testing");
    // Run the real test alongside a minimum-duration timer so a fast
    // round-trip still gives the user a moment to perceive that a test
    // actually happened, rather than an instant flip.
    const [outcome] = await Promise.all([
      services.keychain.testConnection(draft()).then(
        (result) => ({ ok: true, result }) as const,
        () => ({ ok: false, result: null }) as const,
      ),
      delay(minTestDurationMs),
    ]);
    if (outcome.ok && outcome.result.ok) {
      setTestState("passed");
      toasts.add({
        variant: "success",
        title: "Connected",
        description: outcome.result.message,
      });
    } else if (outcome.ok) {
      setTestState("failed");
      setShake(true);
      toasts.add({
        variant: "error",
        title: "Couldn't connect",
        description: outcome.result.message,
      });
    } else {
      setTestState("failed");
      setShake(true);
      toasts.add({
        variant: "error",
        title: "Couldn't connect",
        description: "Something went wrong while testing the connection.",
      });
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const conn: Connection = {
        id: existing?.id ?? crypto.randomUUID(),
        name: form.name,
        endpoint: form.endpoint,
        bucket: form.bucket,
        region: form.region || undefined,
        lastPrefix: existing?.lastPrefix ?? "",
        createdAt: existing?.createdAt ?? Date.now(),
      };
      await services.connections.save(conn, {
        accessKey: form.accessKey,
        secretKey: form.secretKey,
      });
      onSaved(conn);
    } catch (e) {
      toasts.add({
        variant: "error",
        title: "Couldn't save connection",
        description: String(e),
      });
    } finally {
      setSaving(false);
    }
  }

  const ready = testState === "passed";

  return (
    <form
      className="grid grid-cols-1 items-start gap-4 short:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !saving) void handleSave();
        else if (testState !== "testing") void handleTest();
      }}
    >
      <Input
        label="Name"
        placeholder="e.g. Videos"
        value={form.name}
        onChange={(e) => update("name", e.target.value)}
        required
      />
      <Input
        label="Endpoint URL"
        placeholder="https://..."
        value={form.endpoint}
        onChange={(e) => update("endpoint", e.target.value)}
        required
      />
      <Input
        label="Access key"
        value={form.accessKey}
        onChange={(e) => update("accessKey", e.target.value)}
        required
      />
      <SensitiveInput
        label="Secret key"
        value={form.secretKey}
        onValueChange={(value) => update("secretKey", value)}
      />
      <Input
        label="Storage name"
        description={STORAGE_NAME_BRIDGE}
        value={form.bucket}
        onChange={(e) => update("bucket", e.target.value)}
        required
      />
      <Input
        label="Region"
        required={false}
        value={form.region}
        onChange={(e) => update("region", e.target.value)}
      />

      <Button
        type="submit"
        variant={ready ? "primary" : "secondary"}
        loading={testState === "testing" || (ready && saving)}
        className={`w-full justify-center short:col-span-2 ${shake ? "lopload-shake" : ""}`}
      >
        {/* Both labels are always mounted, stacked in the same grid cell, and
            crossfade via opacity/transform — this animates the swap instead
            of jumping straight from one word to the other. aria-hidden keeps
            the inactive label out of the accessible name. */}
        <span className="relative grid">
          <span
            aria-hidden={ready}
            className={`col-start-1 row-start-1 transition-[opacity,translate] duration-200 ease-out ${
              ready ? "-translate-y-1 opacity-0" : "translate-y-0 opacity-100"
            }`}
          >
            Test connection
          </span>
          <span
            aria-hidden={!ready}
            className={`col-start-1 row-start-1 transition-[opacity,translate] duration-200 ease-out ${
              ready ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0"
            }`}
          >
            Save connection
          </span>
        </span>
      </Button>
    </form>
  );
}
