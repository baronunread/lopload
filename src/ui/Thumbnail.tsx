import { useEffect, useState } from "react";
import { FileIcon, FilmStripIcon, FolderIcon, ImageIcon } from "@phosphor-icons/react";
import { isImageName, isVideoName } from "./format";
import { useServices } from "./services";
import { fetchThumbnailUrl, peekThumbnailUrl } from "./thumbnailCache";

export interface ThumbnailProps {
  connectionId: string;
  entryKey: string;
  name: string;
  kind: "file" | "folder";
}

/** Small preview cell for image files; a type icon otherwise (videos get a
 * film-strip icon — fetching video bytes for a frame isn't worth it, and
 * frame 0 is usually black anyway).
 *
 * Always renders a fixed 32px box so rows never shift when a preview
 * arrives: the icon shows immediately and the image cross-fades in on top
 * of it once loaded. */
export function Thumbnail({ connectionId, entryKey, name, kind }: ThumbnailProps) {
  const services = useServices();
  const isVideo = kind === "file" && isVideoName(name);
  const previewable = kind === "file" && isImageName(name);
  // Rows are keyed by entry key, so this component never sees entryKey
  // change — reading the cache in the initializer is safe and lets
  // remounted rows (virtualized scrolling) paint the image on first render.
  const [url, setUrl] = useState<string | null>(() =>
    previewable ? (peekThumbnailUrl(connectionId, entryKey) ?? null) : null,
  );
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!previewable || peekThumbnailUrl(connectionId, entryKey) !== undefined) return;
    let cancelled = false;
    fetchThumbnailUrl(connectionId, entryKey, () =>
      services.browser.getThumbnailUrl(connectionId, entryKey),
    )
      .then((result) => {
        if (!cancelled) setUrl(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, entryKey, previewable]);

  if (kind === "folder") {
    return (
      <span className="flex h-8 w-8 shrink-0 items-center justify-center">
        <FolderIcon size={20} weight="fill" className="text-kumo-brand" aria-hidden />
      </span>
    );
  }

  const showMedia = previewable && url !== null && !failed;
  const placeholder = isVideo ? (
    <FilmStripIcon size={20} className="text-kumo-subtle" aria-hidden />
  ) : previewable ? (
    <ImageIcon size={20} className="text-kumo-subtle" aria-hidden />
  ) : (
    <FileIcon size={20} className="text-kumo-subtle" aria-hidden />
  );

  return (
    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
      <span
        className={`lopload-settle flex items-center justify-center ${loaded ? "opacity-0" : "opacity-100"}`}
      >
        {placeholder}
      </span>
      {showMedia && (
        <img
          src={url}
          alt={`Preview of ${name}`}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`lopload-settle lopload-media-outline absolute inset-0 h-8 w-8 rounded object-cover ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </span>
  );
}
