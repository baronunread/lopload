import { Breadcrumbs, DropdownMenu } from "@cloudflare/kumo";
import { HouseIcon } from "@phosphor-icons/react";
import { segmentsForPrefix } from "../format";

/** Breadcrumb ancestors are drop targets during a drag-to-move: every
 * candidate gets a dashed hint ring so it reads as droppable at all, and
 * the hovered one lights up like folder rows do. Idle crumbs keep a
 * transparent box (never `display: contents` — backgrounds and rings don't
 * render on a box-less element).
 *
 * `min-w-0 max-w-[35%]`: kumo's crumbs truncate themselves, but only if the
 * wrapper span lets them shrink — an unconstrained inline-flex sizes to its
 * content, so one long folder name would push the current crumb (and, at
 * narrow widths, the whole trail) out of view with no ellipsis. */
function crumbDropClass(dragActive: boolean, isTarget: boolean): string {
  const base = "inline-flex min-w-0 max-w-[35%] items-center rounded-md px-1 py-0.5 ring-inset";
  if (!dragActive) return base;
  return isTarget
    ? `${base} bg-kumo-brand/20 ring-1 ring-kumo-brand`
    : `${base} ring-1 ring-dashed ring-kumo-line`;
}

/** Collapse ancestor breadcrumbs behind a "…" menu once the path goes deeper
 * than this many segments — keeps Home plus the last two segments visible
 * (so the trail still reads as Home/…/parent/current) no matter how deep the
 * real path is, so the toolbar's Filter/New folder/Trash/Upload controls
 * never get pushed out of view. A plain count threshold rather than a
 * measured-overflow check — plenty for how deep real paths get, and far
 * simpler. */
const BREADCRUMB_COLLAPSE_THRESHOLD = 3;

/** Splits path segments into the ones a collapsed breadcrumb trail hides
 * behind "…" and the ones it still shows (Home is rendered separately by
 * the caller and isn't part of either list). */
function splitBreadcrumbSegments(segments: string[]): {
  hidden: string[];
  visible: string[];
} {
  if (segments.length <= BREADCRUMB_COLLAPSE_THRESHOLD) {
    return { hidden: [], visible: segments };
  }
  return { hidden: segments.slice(0, -2), visible: segments.slice(-2) };
}

export interface RemoteBrowserBreadcrumbsProps {
  prefix: string;
  navigate: (next: string) => void;
  dragActive: boolean;
  dropTarget: string | null;
  dropTargetHandlers: (toPrefix: string) => {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
}

/** The current folder's path as a breadcrumb trail: Home, a "…" menu for
 * collapsed ancestors once the path runs deep, then the last two segments —
 * every crumb except the current one is also a drag-to-move drop target. */
export function RemoteBrowserBreadcrumbs({
  prefix,
  navigate,
  dragActive,
  dropTarget,
  dropTargetHandlers,
}: RemoteBrowserBreadcrumbsProps) {
  const segments = segmentsForPrefix(prefix);
  const { hidden: hiddenSegments, visible: visibleSegments } = splitBreadcrumbSegments(segments);

  return (
    <Breadcrumbs className="min-w-0 flex-1 overflow-hidden">
      {/* Wraps Breadcrumbs.Link's real <a href="#">, so keyboard users
          already reach and activate it via that anchor (the click
          bubbles up to this span) — no separate role/tabIndex needed.
          Home is short and always meaningful — it never shrinks. */}
      <span
        className={`shrink-0 ${crumbDropClass(dragActive, dropTarget === "")}`}
        onClick={(e) => {
          e.preventDefault();
          navigate("");
        }}
        {...dropTargetHandlers("")}
      >
        <Breadcrumbs.Link href="#" icon={<HouseIcon size={16} />}>
          Home
        </Breadcrumbs.Link>
      </span>
      {hiddenSegments.length > 0 && (
        <span className="contents">
          <Breadcrumbs.Separator />
          {/* Hidden ancestors aren't drag-move drop targets in this
              first pass — only the visible crumbs below (Home + last
              two segments) register drop-target handlers. Hovering
              this trigger during a drag doesn't open the menu either;
              both would be reasonable follow-ups. */}
          <DropdownMenu>
            <DropdownMenu.Trigger>
              <button
                type="button"
                aria-label={`Show ${hiddenSegments.length} hidden folder${
                  hiddenSegments.length === 1 ? "" : "s"
                }`}
                className="inline-flex shrink-0 items-center rounded-md px-1 py-0.5 text-kumo-subtle hover:bg-kumo-tint"
              >
                …
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {hiddenSegments.map((segment, i) => {
                const segPrefix = segments.slice(0, i + 1).join("/") + "/";
                return (
                  <DropdownMenu.Item key={segPrefix} onClick={() => navigate(segPrefix)}>
                    {segment}
                  </DropdownMenu.Item>
                );
              })}
            </DropdownMenu.Content>
          </DropdownMenu>
        </span>
      )}
      {visibleSegments.map((segment, j) => {
        // Absolute index within the full `segments` array — needed to
        // rebuild the same prefix the un-collapsed crumbs always used.
        const i = hiddenSegments.length + j;
        const segPrefix = segments.slice(0, i + 1).join("/") + "/";
        const isLast = j === visibleSegments.length - 1;
        return (
          <span key={segPrefix} className="contents">
            <Breadcrumbs.Separator />
            {isLast ? (
              // The current folder is what the user is looking at — it
              // shrinks last (shrink-0 up to its cap), so a long ancestor
              // truncates before eating the current crumb's space.
              <span className="flex min-w-0 max-w-[50%] shrink-0" title={segment}>
                <Breadcrumbs.Current>{segment}</Breadcrumbs.Current>
              </span>
            ) : (
              // Same wrapper-around-a-real-anchor pattern as the Home
              // crumb above — keyboard access comes from the nested
              // Breadcrumbs.Link, so no role is added here either.
              <span
                className={crumbDropClass(dragActive, dropTarget === segPrefix)}
                title={segment}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(segPrefix);
                }}
                {...dropTargetHandlers(segPrefix)}
              >
                <Breadcrumbs.Link href="#">{segment}</Breadcrumbs.Link>
              </span>
            )}
          </span>
        );
      })}
    </Breadcrumbs>
  );
}
