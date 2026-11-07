/**
 * Tiling layout: a binary tree of splits whose leaves are panels.
 *
 * A new panel dropped on an edge of an existing panel splits the existing panel along the same
 * edge, and one dropped on its center replaces it. Removing a panel collapses its parent split.
 * The tree is plain JSON, thus it can be stored and put into an export.
 */

export type SplitDir = 'row' | 'col';
export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'centre';

export type LayoutNode = { kind: 'panel'; id: string } | { kind: 'split'; dir: SplitDir; ratio: number; a: LayoutNode; b: LayoutNode };

export function panelIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  return node.kind === 'panel' ? [node.id] : [...panelIds(node.a), ...panelIds(node.b)];
}

export function hasPanel(node: LayoutNode | null, id: string): boolean {
  return panelIds(node).includes(id);
}

/** Returns a new tree with `newId` placed relative to `targetId` in `zone`. */
export function splitAt(node: LayoutNode, targetId: string, newId: string, zone: DropZone): LayoutNode {
  if (node.kind === 'panel') {
    if (node.id !== targetId) return node;
    if (zone === 'centre') return { kind: 'panel', id: newId };
    const fresh: LayoutNode = { kind: 'panel', id: newId };
    const dir: SplitDir = zone === 'left' || zone === 'right' ? 'row' : 'col';
    const first = zone === 'left' || zone === 'top';
    return { kind: 'split', dir, ratio: 0.5, a: first ? fresh : node, b: first ? node : fresh };
  }
  return { ...node, a: splitAt(node.a, targetId, newId, zone), b: splitAt(node.b, targetId, newId, zone) };
}

/** Returns the tree without `id`, or null if it was the only panel. */
export function removePanel(node: LayoutNode, id: string): LayoutNode | null {
  if (node.kind === 'panel') return node.id === id ? null : node;
  const a = removePanel(node.a, id);
  const b = removePanel(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

export function setRatio(node: LayoutNode, split: LayoutNode, ratio: number): LayoutNode {
  if (node === split && node.kind === 'split') return { ...node, ratio };
  if (node.kind === 'panel') return node;
  return { ...node, a: setRatio(node.a, split, ratio), b: setRatio(node.b, split, ratio) };
}

/** Panel ids with the area fraction each one occupies, for picking a split target. */
export function panelAreas(node: LayoutNode, area = 1): { id: string; area: number }[] {
  if (node.kind === 'panel') return [{ id: node.id, area }];
  return [...panelAreas(node.a, area * node.ratio), ...panelAreas(node.b, area * (1 - node.ratio))];
}

/** The drop zone for a pointer at (x, y) inside a rectangle of size (w, h), i.e. the nearest edge within 28% of the side, or else the center. */
export function zoneFor(x: number, y: number, w: number, h: number): DropZone {
  const fx = x / Math.max(1, w);
  const fy = y / Math.max(1, h);
  const edge = 0.28;
  const d = [
    { zone: 'left' as DropZone, v: fx },
    { zone: 'right' as DropZone, v: 1 - fx },
    { zone: 'top' as DropZone, v: fy },
    { zone: 'bottom' as DropZone, v: 1 - fy },
  ].sort((p, q) => p.v - q.v)[0];
  return d.v < edge ? d.zone : 'centre';
}

export function isLayoutNode(v: unknown): v is LayoutNode {
  if (!v || typeof v !== 'object') return false;
  const n = v as Record<string, unknown>;
  if (n.kind === 'panel') return typeof n.id === 'string';
  if (n.kind === 'split') {
    return (n.dir === 'row' || n.dir === 'col') && typeof n.ratio === 'number' && isLayoutNode(n.a) && isLayoutNode(n.b);
  }
  return false;
}
