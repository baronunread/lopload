import { useState, type FormEvent } from "react";
import { Button, Empty, Input, SensitiveInput, useKumoToastManager } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";
import { useServices } from "./services";

export interface CredentialsReentryFormProps {
  connection: Connection;
  onSaved: () => void;
  onCancel: () => void;
}

/**
 * Shown in place of a broken listing when the OS keychain couldn't produce
 * this connection's credentials (denied prompt, or an ACL mismatch after a
 * signing identity change). Reuses the same Input/SensitiveInput/Button
 * pieces as SetupForm rather than a full duplicate connection form — only
 * the two secret fields need re-entry, everything else about the connection
 * (endpoint, storage name, region) is unchanged.
 */
export function CredentialsReentryForm({ connection, onSaved, onCancel }: CredentialsReentryFormProps) {
  const services = useServices();
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [saving, setSaving] = useState(false);
  const toasts = useKumoToastManager();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await services.connections.save(connection, { accessKey, secretKey });
      onSaved();
    } catch {
      toasts.add({
        variant: "error",
        title: "Couldn't save credentials",
        description: "Something went wrong — please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Empty
      title="We couldn't read the saved credentials for this storage"
      description="Please enter them again to reconnect."
      contents={
        <form
          className="flex w-full max-w-sm flex-col gap-4 text-left"
          onSubmit={(e) => void handleSubmit(e)}
        >
          <Input
            label="Access key"
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            required
            autoFocus
          />
          <SensitiveInput label="Secret key" value={secretKey} onValueChange={setSecretKey} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={!accessKey || !secretKey}
            >
              Reconnect
            </Button>
          </div>
        </form>
      }
    />
  );
}
