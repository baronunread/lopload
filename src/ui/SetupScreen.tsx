import { useState } from "react";
import { Banner, Button, Input, SensitiveInput } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";
import type { ConnectionDraft } from "./services";
import { useServices } from "./services";

export interface SetupScreenProps {
  /** Connection being edited, if this is "Add storage" from an existing list. */
  existing?: Connection;
  onSaved: (conn: Connection) => void;
  onCancel?: () => void;
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
 * One-screen setup flow, used both on first run and for "Add storage" from
 * the header switcher. Never uses the words bucket/object/key in copy — the
 * field that maps to Connection.bucket is labeled "Storage name".
 */
export function SetupScreen({ existing, onSaved, onCancel }: SetupScreenProps) {
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
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    // Any edit invalidates a prior successful test — re-test before saving.
    setTestState("idle");
    setTestMessage(null);
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
    setTestMessage(null);
    try {
      const result = await services.keychain.testConnection(draft());
      setTestState(result.ok ? "passed" : "failed");
      setTestMessage(result.message);
    } catch {
      setTestState("failed");
      setTestMessage("Something went wrong while testing the connection.");
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
    } finally {
      setSaving(false);
    }
  }

  const canSave = testState === "passed" && !saving;

  return (
    <form
      className="mx-auto flex max-w-md flex-col gap-4 p-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void handleSave();
      }}
    >
      <h1 className="lopload-heading text-xl font-semibold">Add a storage connection</h1>

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
        description="The folder space this connection reads and writes to."
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

      {testMessage && (
        <Banner
          variant={testState === "passed" ? "default" : "error"}
          title={testState === "passed" ? "Connection works" : "Couldn't connect"}
          description={testMessage}
        />
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={handleTest}
          loading={testState === "testing"}
        >
          Test connection
        </Button>
        <Button type="submit" variant="primary" disabled={!canSave}>
          Save
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
