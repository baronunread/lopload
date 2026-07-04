import { Select } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";

const ADD_STORAGE = "__add-storage__";

export interface ConnectionSwitcherProps {
  connections: Connection[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onAddStorage: () => void;
}

/** Header switcher listing saved storage connections by name, plus "Add storage…". */
export function ConnectionSwitcher({
  connections,
  currentId,
  onSwitch,
  onAddStorage,
}: ConnectionSwitcherProps) {
  return (
    <Select
      aria-label="Storage connection"
      placeholder="Choose a storage connection"
      value={currentId ?? undefined}
      renderValue={(value) =>
        connections.find((c) => c.id === value)?.name ?? String(value)
      }
      onValueChange={(value) => {
        if (value === ADD_STORAGE) {
          onAddStorage();
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
    </Select>
  );
}
