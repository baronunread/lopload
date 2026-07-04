import { useEffect, useState } from "react";
import { FileIcon, FolderIcon } from "@phosphor-icons/react";
import { isImageName, isVideoName } from "./format";
import { useServices } from "./services";

export interface ThumbnailProps {
  connectionId: string;
  entryKey: string;
  name: string;
  kind: "file" | "folder";
}

/** Small preview cell for image/video files; a plain icon otherwise. */
export function Thumbnail({ connectionId, entryKey, name, kind }: ThumbnailProps) {
  const services = useServices();
  const [url, setUrl] = useState<string | null>(null);
  const previewable = kind === "file" && (isImageName(name) || isVideoName(name));

  useEffect(() => {
    if (!previewable) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    services.browser.getThumbnailUrl(connectionId, entryKey).then((result) => {
      if (!cancelled) setUrl(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, entryKey, previewable]);

  if (kind === "folder") {
    return <FolderIcon size={20} weight="fill" className="text-kumo-brand" aria-hidden />;
  }

  if (previewable && url) {
    if (isVideoName(name)) {
      return (
        <video
          src={url}
          preload="metadata"
          muted
          className="lopload-settle h-8 w-8 rounded object-cover"
          aria-label={`Preview of ${name}`}
        />
      );
    }
    return (
      <img
        src={url}
        alt={`Preview of ${name}`}
        className="lopload-settle h-8 w-8 rounded object-cover"
      />
    );
  }

  return <FileIcon size={20} className="text-kumo-subtle" aria-hidden />;
}
