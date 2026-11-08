/**
 * The value that `evaluate` returns, as section 3 of spec/tycho-scene.md defines it. Positions are
 * plain arrays of three float64 numbers, thus JSON.stringify writes the result as it is.
 */

export type Vec3 = [number, number, number];

export interface MemberResult {
  index: number;
  line: Vec3[];
  /** Present only when the layer has `head: true`. Null while the track is hidden. */
  head?: Vec3 | null;
}

export interface TrackLayerResult {
  kind: 'track';
  /** Null when the set query does not match any track set, and `members` is then empty. */
  set: string | null;
  members: MemberResult[];
}

export interface ArrowMemberResult {
  index: number;
  /** The point at the reading. Null while the track is hidden. */
  base: Vec3 | null;
  /** The base displaced by `scale` times the vector, blended in the same way. Null while the track is hidden. */
  tip: Vec3 | null;
}

export interface ArrowLayerResult {
  kind: 'arrow';
  /** Null when the set query does not match any track set, and `members` is then empty. */
  set: string | null;
  members: ArrowMemberResult[];
}

export interface BodyLayerResult {
  kind: 'body';
  body: string;
  /** Null when the view's driver does not resolve to a track. */
  position: Vec3 | null;
  /** Present only when the layer has a `trail`. */
  trail?: Vec3[];
}

export interface MarkLayerResult {
  kind: 'axes' | 'grid';
}

export type LayerResult = TrackLayerResult | ArrowLayerResult | BodyLayerResult | MarkLayerResult;

export interface PanelResult {
  frame: string;
  layers: LayerResult[];
}

export interface EvaluateResult {
  panels: Record<string, PanelResult>;
}
