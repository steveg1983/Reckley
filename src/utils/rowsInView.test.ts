import { describe, it, expect, afterEach } from 'vitest';
import { keysOfRowsInView } from './rowsInView';

/**
 * "SELECT ALL IN VIEW" — which rows are on screen. jsdom has no layout, so
 * each row is given the rectangle a browser would report.
 */

const rect = (top: number, height: number): DOMRect => ({
  top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}),
});

function list(tops: number[]): HTMLElement {
  const root = document.createElement('div');
  tops.forEach((top, index) => {
    const row = document.createElement('div');
    row.setAttribute('data-key', `row-${index}`);
    row.getBoundingClientRect = () => rect(top, 40);
    root.appendChild(row);
  });
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('keysOfRowsInView', () => {
  it('counts a row whose middle is inside the window', () => {
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    const root = list([-100, -15, 100, 470, 490, 900]);
    // -15+20 = 5 (in); 470+20 = 490 (in); 490+20 = 510 (out)
    expect(keysOfRowsInView(root, 'data-key')).toEqual(['row-1', 'row-2', 'row-3']);
  });

  it('a row under the pinned toolbar does not count as seen', () => {
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    const root = list([10, 60, 120]);
    // Toolbar covers to 80: row-0 (middle 30) and row-1 (middle 80) are on the line or under it.
    expect(keysOfRowsInView(root, 'data-key', 81)).toEqual(['row-2']);
  });
});
