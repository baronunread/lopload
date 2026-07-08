import { useState } from "react";
import { Button, Dialog, Input, Select, useKumoToastManager } from "@cloudflare/kumo";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useServices } from "../services";

export interface ShareLinkDialogProps {
  connectionId: string;
  /** Full key of the file being shared. */
  fileKey: string;
  /** Display name shown in the dialog title. */
  fileName: string;
  onClose: () => void;
}

type ExpiryOption = { label: string; seconds: number };

/** Options for the presigned link's lifetime — 7 days is SigV4's hard
 * maximum (src/lib/s3/client.ts's MAX_COPY_LINK_EXPIRY_SECONDS), so nothing
 * here exceeds it. */
const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
];

const DEFAULT_EXPIRY_SECONDS = EXPIRY_OPTIONS[1].seconds;

/** How long the copy button shows its "Copied" confirmation before
 * reverting — long enough to register, short enough not to linger. */
const COPIED_RESET_MS = 2000;

/** "Copy link…" dialog: pick an expiry, generate a presigned URL, then copy
 * it with a fresh user gesture (the copy button's own click), so the
 * clipboard write actually succeeds under WKWebView's transient-activation
 * rules — the old flow copied inside a `.then()` after the presign's async
 * round trip, by which point the click's activation had already expired. */
export function ShareLinkDialog({ connectionId, fileKey, fileName, onClose }: ShareLinkDialogProps) {
  const services = useServices();
  const toasts = useKumoToastManager();
  const [expirySeconds, setExpirySeconds] = useState(DEFAULT_EXPIRY_SECONDS);
  const [link, setLink] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function generate() {
    setGenerating(true);
    setGenerateError(null);
    try {
      const url = await services.browser.copyLink(connectionId, fileKey, expirySeconds);
      setLink(url);
      setCopyState("idle");
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setGenerating(false);
    }
  }

  function handleExpiryChange(seconds: number | null) {
    if (seconds === null) return;
    setExpirySeconds(seconds);
    // The existing link was signed for the old expiry — clear it so the
    // user re-generates rather than copying a link with the wrong lifetime.
    setLink(null);
    setCopyState("idle");
  }

  function handleCopy() {
    if (!link) return;
    // Called directly from the button's click handler (not after an await)
    // so the clipboard write keeps the click's transient user activation.
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopyState("copied");
        setTimeout(() => setCopyState((s) => (s === "copied" ? "idle" : s)), COPIED_RESET_MS);
      })
      .catch(() => {
        setCopyState("failed");
        toasts.add({
          variant: "error",
          title: "Couldn't copy link",
          description: "Select the link text below and copy it manually.",
        });
      });
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog className="w-full max-w-md p-6">
        <Dialog.Title>Copy link — {fileName}</Dialog.Title>

        <div className="mt-3">
          <Select
            label="Expires after"
            value={expirySeconds}
            onValueChange={handleExpiryChange}
            renderValue={(v) => EXPIRY_OPTIONS.find((o) => o.seconds === v)?.label}
          >
            {EXPIRY_OPTIONS.map((option) => (
              <Select.Option key={option.seconds} value={option.seconds}>
                {option.label}
              </Select.Option>
            ))}
          </Select>
        </div>

        {link ? (
          <div className="mt-4 flex items-end gap-2">
            <div className="flex-1">
              <Input label="Link" value={link} readOnly onFocus={(e) => e.target.select()} />
            </div>
            <Button
              variant="secondary"
              shape="square"
              aria-label={copyState === "copied" ? "Copied" : "Copy link"}
              icon={copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
              onClick={handleCopy}
            />
          </div>
        ) : (
          <div className="mt-4">
            {generateError && <p className="mb-2 text-sm text-kumo-danger">{generateError}</p>}
            <Button variant="primary" loading={generating} onClick={() => void generate()}>
              Create link
            </Button>
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Dialog.Close render={(p) => <Button variant="secondary" {...p} />}>
            {link ? "Done" : "Cancel"}
          </Dialog.Close>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
