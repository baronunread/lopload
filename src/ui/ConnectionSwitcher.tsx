import { Select } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";

const ADD_STORAGE = "__add-storage__";
const MANAGE_STORAGE = "__manage-storage__";

export interface ConnectionSwitcherProps {
  connections: Connection[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onAddStorage: () => void;
  onManageStorage: () => void;
}

/**
 * Header switcher listing saved storage connections by name, plus
 * "Add storage…" and "Manage storage connections…" (removal lives there,
 * not inline in the list, since a dropdown option isn't a safe place for a
 * destructive click target).
 */
export function ConnectionSwitcher({
  connections,
  currentId,
  onSwitch,
  onAddStorage,
  onManageStorage,
}: ConnectionSwitcherProps) {
  return (
    <Select
      aria-label="Storage connection"
      placeholder="Choose a storage connection"
      className="w-full min-w-0 max-w-full sm:max-w-xs"
      value={currentId ?? undefined}
      renderValue={(value) => (
        <span className="block truncate">
          {connections.find((c) => c.id === value)?.name ?? String(value)}
        </span>
      )}
      onValueChange={(value) => {
        if (value === ADD_STORAGE) {
          onAddStorage();
        } else if (value === MANAGE_STORAGE) {
          onManageStorage();
        } else if (typeof value === "string") {
          onSwitch(value);
        }
      }}
    >
      {connections.map((conn) => (
        <Select.Option key={conn.id} value={conn.id}>
          {conn.name}
        </Select.Option>
      ))}
      <Select.Separator />
      <Select.Option value={ADD_STORAGE}>Add storage…</Select.Option>
      <Select.Option value={MANAGE_STORAGE}>Manage storage connections…</Select.Option>
    </Select>
  );
}
