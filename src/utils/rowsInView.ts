/**
 * Which rows can the person see right now?
 *
 * "Select all in view" (owner, 15 Nov 2026): tick what is on screen, scroll,
 * press again to add the next screenful. A row counts when its middle is
 * inside the visible part of the list: the window, cut down to the nearest
 * scrolling container, minus whatever is pinned over its top (the toolbar
 * the button sits in).
 *
 * Reads layout only; the caller decides what a row's key means.
 */

const isScroller = (element: HTMLElement): boolean => {
  const overflowY = window.getComputedStyle(element).overflowY;
  return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight;
};

/** The nearest ancestor that scrolls, or null for the page itself. */
export function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    if (isScroller(current)) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * The keys of the rows whose middles are visible.
 *
 * @param root      the element holding the rows
 * @param attribute the data attribute each row carries its key in
 * @param coveredTo the bottom edge of anything pinned over the list, in
 *                  viewport pixels; rows whose middle is above it are hidden
 */
export function keysOfRowsInView(root: HTMLElement, attribute: string, coveredTo = -Infinity): string[] {
  const scroller = scrollingAncestor(root);
  const frame = scroller?.getBoundingClientRect();
  const top = Math.max(frame?.top ?? 0, 0, coveredTo);
  const bottom = Math.min(frame?.bottom ?? window.innerHeight, window.innerHeight);

  const keys: string[] = [];
  root.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach(row => {
    const rect = row.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) return;
    const middle = rect.top + rect.height / 2;
    const key = row.getAttribute(attribute);
    if (key && middle >= top && middle <= bottom) keys.push(key);
  });
  return keys;
}
