/**
 * The value that `evaluate` returns, as section 3 of spec/tycho-scene.md defines it. Positions are
 * plain arrays of three float64 numbers, thus JSON.stringify writes the result as it is.
 */

export type Vec3 = [number, number, number];

export interface MemberResult {
  index: number;
  line: Vec3[];
  /** Present only when the layer has `head: true`. Null while the trajectory is hidden. */
  head?: Vec3 | null;
}

export interface TrajectoriesLayerResult {
  kind: 'trajectories';
  /** Null when the set query does not match any trajectory set, and `members` is then empty. */
  set: string | null;
  members: MemberResult[];
}

export interface ArrowMemberResult {
  index: number;
  /** The point at the reading. Null while the trajectory is hidden. */
  base: Vec3 | null;
  /** The base displaced by `scale` times the vector, blended in the same way. Null while the trajectory is hidden. */
  tip: Vec3 | null;
}

export interface ArrowLayerResult {
  kind: 'arrow';
  /** Null when the set query does not match any trajectory set, and `members` is then empty. */
  set: string | null;
  members: ArrowMemberResult[];
}

export interface InsetBoxLayerResult {
  kind: 'inset_box';
  /** The declared panel whose window the box outlines. */
  panel: string;
  /** The first shown panel in layout order that names `panel`, or null when the layout does not show it, and the four keys below are then null. */
  shown_panel: string | null;
  /** The display frame of the target panel. */
  frame: string | null;
  /** The image of the origin of the target frame in the display frame, at the reading of the reference trajectory. Null when the reference does not resolve to a trajectory. */
  origin: Vec3 | null;
  /** The images of the three unit points of the target frame minus `origin`, i.e. the columns of the linear part of the map. Null as `origin` is. */
  axes: [Vec3, Vec3, Vec3] | null;
}

export interface BodyLayerResult {
  kind: 'body';
  body: string;
  /** Null when the reference does not resolve to a trajectory. */
  position: Vec3 | null;
  /** Present only when the layer has a `trail`. */
  trail?: Vec3[];
}

export interface MarkLayerResult {
  kind: 'axes' | 'grid';
}

export interface LabelLayerResult {
  kind: 'label';
  /** The anchor in the display frame (rule `label`), or null for an anchor on the screen or one that does not resolve. */
  position: Vec3 | null;
}

export interface PointsMemberResult {
  index: number;
  /** The drawn samples in storage order (rule `points`). Empty while the member is hidden or before its first sample is reached. */
  points: Vec3[];
}

export interface PointsLayerResult {
  kind: 'points';
  /** Null when the set query does not match any trajectory set, and `members` is then empty. */
  set: string | null;
  members: PointsMemberResult[];
}

export type LayerResult =
  TrajectoriesLayerResult | ArrowLayerResult | InsetBoxLayerResult | BodyLayerResult | MarkLayerResult | LabelLayerResult | PointsLayerResult;

/** The window of a camera with keyframes (rule `camera-keyframes`). */
export interface CameraResult {
  center: [number, number];
  width: number;
  /** Null unless the keyframes give a height, under a camera of free aspect. */
  height: number | null;
}

export interface PanelResult {
  frame: string;
  layers: LayerResult[];
  /** Present only when the camera of the panel has keyframes, and null when the camera does not have a window at the frame (rule `camera-keyframes`). */
  camera?: CameraResult | null;
}

export interface EvaluateResult {
  panels: Record<string, PanelResult>;
}
