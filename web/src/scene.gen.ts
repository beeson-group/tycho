/**
 * Types for scene.tys, generated from spec/scene.schema.json by scripts/gen-types.mjs.
 * Do not edit. Run `npm run gen:types` after changing the schema.
 */

/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "color".
 */
export type Color = string;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "id".
 */
export type Id = string;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "scalar".
 */
export type Scalar = number | Attr | ChannelRef;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "name".
 */
export type Name = string;
/**
 * @minItems 3
 * @maxItems 3
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "point".
 */
export type Point = [ConstantScalar, ConstantScalar, ConstantScalar];
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "constantScalar".
 */
export type ConstantScalar = number | Attr;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "input".
 */
export type Input =
  | {
      kind: 'parameter';
      parameter: Name;
      default: number;
      scope?: 'shared' | 'per_panel';
    }
  | {
      kind: 'choice';
      /**
       * @minItems 1
       */
      values: [string, ...string[]];
      labels?: string[];
      default: string;
      scope?: 'shared' | 'per_panel';
    }
  | {
      kind: 'toggle';
      default: boolean;
      scope?: 'shared' | 'per_panel';
    };
/**
 * @minItems 1
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "keyframes".
 */
export type Keyframes = [
  [number | string, number | string] | [number | string, number | string, number | string],
  ...([number | string, number | string] | [number | string, number | string, number | string])[]
];
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "camera".
 */
export type Camera =
  | {
      kind: '2d';
      plane?: 'xy' | 'xz' | 'yz';
      aspect?: 'equal' | 'free';
      /**
       * @minItems 1
       */
      keyframes?: [
        {
          at: number;
          width: number;
          height?: number;
          /**
           * @minItems 2
           * @maxItems 2
           */
          center?: [number, number];
          /**
           * @minItems 1
           */
          follow?: [
            {
              layer: number;
              member: number;
            },
            ...{
              layer: number;
              member: number;
            }[]
          ];
          /**
           * @minItems 2
           * @maxItems 2
           */
          offset?: [number, number];
          ease?: Ease;
        },
        ...{
          at: number;
          width: number;
          height?: number;
          /**
           * @minItems 2
           * @maxItems 2
           */
          center?: [number, number];
          /**
           * @minItems 1
           */
          follow?: [
            {
              layer: number;
              member: number;
            },
            ...{
              layer: number;
              member: number;
            }[]
          ];
          /**
           * @minItems 2
           * @maxItems 2
           */
          offset?: [number, number];
          ease?: Ease;
        }[]
      ];
    }
  | {
      kind: '3d';
      projection?: 'orthographic' | 'perspective';
      up?: 'x' | 'y' | 'z';
      /**
       * @minItems 3
       * @maxItems 3
       */
      stretch?: [number, number, number];
      auto_rotate?: number;
    };
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "ease".
 */
export type Ease = 'linear' | 'smooth' | 'in' | 'out' | 'in-out' | 'hold';
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "setQuery".
 */
export type SetQuery =
  | {
      set: Id;
    }
  | {
      tags: {
        [k: string]: StringValue | undefined;
      };
    };
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "stringValue".
 */
export type StringValue = string | InputRef;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "layer".
 */
export type Layer =
  | {
      kind: 'trajectories';
      sets: SetQuery;
      members: MemberRef;
      reveal?: 'none' | 'grow' | 'trail';
      trail?: Trail;
      head?:
        | boolean
        | {
            color?: Color;
            size?: Size;
            shape?: 'disc' | 'ring' | 'square' | 'diamond' | 'triangle' | 'star' | 'cross' | 'plus';
            edge?: Color;
            edge_width?: number | Keyframed;
            opacity?: Opacity;
            glow?: {
              channel: Name;
              color?: Color;
              size?: number;
              opacity?: number;
            };
          };
      before?: 'clamp' | 'hidden';
      after?: 'clamp' | 'hidden';
      read_from?: 'own' | 'reference';
      fit?: boolean;
      color?: ColorSpec;
      opacity?: Opacity;
      width?: number;
      highlight?: {
        input: Id;
        width?: number;
        opacity?: number;
        kernel?: {
          width: number;
          opacity: number;
        };
      };
      visible?: InputRef;
      clock?: LayerClock;
      line?: boolean;
      group_opacity?: boolean;
      /**
       * @minItems 2
       * @maxItems 2
       */
      dash?: [number, number];
      fill?: {
        base?: number;
        color?: Color;
        opacity?: number;
      };
    }
  | {
      kind: 'arrow';
      sets: SetQuery;
      members: MemberRef;
      /**
       * @minItems 2
       * @maxItems 3
       */
      vector: [Name, Name] | [Name, Name, Name];
      scale?: ConstantScalar;
      before?: 'clamp' | 'hidden';
      after?: 'clamp' | 'hidden';
      color?: Color;
      opacity?: Opacity;
      width?: number;
      head?: {
        size?: number;
      };
      visible?: InputRef;
      clock?: LayerClock;
    }
  | {
      kind: 'inset_box';
      panel: Id;
      color?: Color;
      opacity?: Opacity;
      width?: number;
      /**
       * @minItems 2
       * @maxItems 2
       */
      dash?: [number, number];
      min_size?: number;
      visible?: InputRef;
    }
  | {
      kind: 'body';
      body: Id;
      trail?: Trail;
      size?: number;
      visible?: InputRef;
      opacity?: Opacity;
    }
  | {
      kind: 'axes';
      span?: 'positive' | 'full' | 'box';
      visible?: InputRef;
      ticks?: ('x' | 'y')[];
      size?: number;
      opacity?: Opacity;
      /**
       * @minItems 2
       * @maxItems 2
       */
      titles?: [Text, Text];
    }
  | {
      kind: 'grid';
      labels?: boolean;
      visible?: InputRef;
      opacity?: Opacity;
    }
  | {
      kind: 'label';
      text: Text;
      at: Anchor;
      /**
       * @minItems 2
       * @maxItems 2
       */
      offset?: [number, number];
      align?: 'start' | 'center' | 'end';
      baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
      size?: number;
      color?: Color;
      weight?: 'normal' | 'bold';
      linespacing?: number;
      box?: Box;
      opacity?: Opacity;
      leader?:
        | boolean
        | {
            color?: Color;
            width?: number;
          };
      clock?: LayerClock;
      visible?: InputRef;
    }
  | {
      kind: 'points';
      sets: SetQuery;
      members: MemberRef;
      marker?: Marker;
      reveal?: 'none' | 'grow';
      before?: 'clamp' | 'hidden';
      after?: 'clamp' | 'hidden';
      clock?: LayerClock;
      fit?: boolean;
      opacity?: Opacity;
      visible?: InputRef;
    };
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "memberRef".
 */
export type MemberRef =
  | 'all'
  | {
      index: number;
    }
  | {
      evenly_spaced: number;
    }
  | InputRef;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "size".
 */
export type Size = number | Keyframed;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "opacity".
 */
export type Opacity = number | Keyframed;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "colorSpec".
 */
export type ColorSpec =
  | Color
  | {
      parameter: Name;
      colormap: ColormapName | ColormapByChoice;
      /**
       * @minItems 2
       * @maxItems 2
       */
      range?: [number, number];
      /**
       * @minItems 2
       * @maxItems 2
       */
      truncate?: [number, number];
    }
  | {
      channel: Name;
      colormap: ColormapName | ColormapByChoice;
      /**
       * @minItems 2
       * @maxItems 2
       */
      range?: [number, number];
      /**
       * @minItems 2
       * @maxItems 2
       */
      truncate?: [number, number];
    }
  | {
      channel: Name;
      /**
       * @minItems 1
       */
      thresholds: [number, ...number[]];
      /**
       * @minItems 2
       */
      colors: [Color, Color, ...Color[]];
    };
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "colormapName".
 */
export type ColormapName = 'viridis' | 'plasma' | 'cividis' | 'blues' | 'reds';
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "text".
 */
export type Text = string | TextPart[];
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "textPart".
 */
export type TextPart =
  | string
  | {
      input: Id;
      digits?: number;
      decimals?: number;
      grouping?: boolean;
      factor?: number;
      offset?: number;
      width?: number;
    }
  | {
      parameter: Name;
      digits?: number;
      decimals?: number;
      grouping?: boolean;
      factor?: number;
      offset?: number;
      width?: number;
    }
  | {
      attr: Name;
      digits?: number;
      decimals?: number;
      grouping?: boolean;
      factor?: number;
      offset?: number;
      width?: number;
    }
  | {
      channel: Name;
      digits?: number;
      decimals?: number;
      grouping?: boolean;
      factor?: number;
      offset?: number;
      width?: number;
    }
  | {
      clock: 'frame_index' | 'frame_count' | 'value' | 'time';
      digits?: number;
      decimals?: number;
      grouping?: boolean;
      factor?: number;
      offset?: number;
      width?: number;
    }
  | {
      keyframes: Keyframes;
      digits?: number;
      decimals?: number;
      grouping?: boolean;
      factor?: number;
      offset?: number;
      width?: number;
    }
  | {
      timed_text: [number | string, number | string][];
    }
  | {
      sub: string;
    }
  | {
      sup: string;
    };
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "anchor".
 */
export type Anchor =
  | {
      /**
       * @minItems 3
       * @maxItems 3
       */
      point: [number, number, number];
      frame?: Id;
    }
  | {
      sets: SetQuery;
      member: number;
    }
  | {
      /**
       * @minItems 2
       * @maxItems 2
       */
      screen: [number, number];
    };
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "control".
 */
export type Control =
  | {
      kind: 'slider';
      input: Id;
      label: string;
      domain: SetQuery;
    }
  | {
      kind: 'tabs' | 'toggle';
      input: Id;
      label: string;
    }
  | {
      kind: 'playback';
    };
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "layout".
 */
export type Layout =
  | {
      kind: 'panel';
      id: Id;
    }
  | {
      kind: 'split';
      dir: 'row' | 'col';
      ratio: number;
      a: Layout;
      b: Layout;
      keyframes?: Keyframes;
    };
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "overlay".
 */
export type Overlay =
  | {
      kind: 'text';
      text: Text;
      /**
       * @minItems 2
       * @maxItems 2
       */
      at: [number, number];
      align?: 'start' | 'center' | 'end';
      baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
      size?: number;
      color?: Color;
      weight?: 'normal' | 'bold';
      linespacing?: number;
      box?: Box;
      opacity?: Opacity;
    }
  | {
      kind: 'legend';
      /**
       * @minItems 2
       * @maxItems 2
       */
      at: [number, number];
      entries: {
        label:
          | string
          | (
              | string
              | {
                  sub: string;
                }
              | {
                  sup: string;
                }
            )[];
        line?: {
          color?: Color;
          width?: number;
          /**
           * @minItems 2
           * @maxItems 2
           */
          dash?: [number, number];
          opacity?: number;
        };
        marker?: Marker;
        /**
         * @minItems 1
         */
        colors?: [Color, ...Color[]];
      }[];
      columns?: number;
      size?: number;
      color?: Color;
      align?: 'start' | 'center' | 'end';
      baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
      opacity?: Opacity;
      handle_length?: number;
      handle_pad?: number;
      column_spacing?: number;
    };

/**
 * Structure of scene.tys, version 0.5. The rules that this schema cannot express are in tycho-scene.md.
 */
export interface Scene {
  format: 'tycho-scene';
  version: string;
  requires?: string[];
  generator?: string;
  title?: string;
  theme?: Theme;
  frames: {
    [k: string]: Frame | undefined;
  };
  bodies?: {
    [k: string]: Body | undefined;
  };
  trajectory_sets: {
    [k: string]: TrajectorySet | undefined;
  };
  inputs?: {
    [k: string]: Input | undefined;
  };
  clock: Clock;
  panels: {
    [k: string]: Panel | undefined;
  };
  controls?: Control[];
  readouts?: Readout[];
  initial: State;
  steps?: {
    id: Id;
    at: number;
    label?: string;
  }[];
  overlays?: Overlay[];
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "theme".
 */
export interface Theme {
  background?: Color;
  foreground?: Color;
  grid?: Color;
  font?: string;
  gutter?: Color;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "frame".
 */
export interface Frame {
  label?: string;
  /**
   * @minItems 3
   * @maxItems 3
   */
  axes?: [string, string, string];
  unit?: string;
  parent?: Id;
  origin?:
    | [Scalar, Scalar, Scalar]
    | {
        body: Id;
      };
  rotation?: {
    axis: 'x' | 'y' | 'z';
    angle: Scalar;
  };
  scale?: Scalar;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "attr".
 */
export interface Attr {
  attr: Name;
  factor?: number;
  offset?: number;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "channelRef".
 */
export interface ChannelRef {
  channel: Name;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "body".
 */
export interface Body {
  label?: string;
  frame: Id;
  position: Point;
  color?: Color;
  image?: Name;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "trajectorySet".
 */
export interface TrajectorySet {
  label?: string;
  frame: Id;
  tags?: {
    [k: string]: string | undefined;
  };
  attrs?: {
    [k: string]: number | undefined;
  };
  trajectories: number;
  offsets: Name;
  positions: Name;
  channels?: {
    [k: string]:
      | {
          array: Name;
          interp?: 'linear' | 'hold';
          unit?: string;
        }
      | undefined;
  };
  parameters?: {
    [k: string]:
      | {
          array: Name;
          label?: string;
          unit?: string;
        }
      | undefined;
  };
  periodic?: boolean;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "clock".
 */
export interface Clock {
  mode: 'fraction' | 'epoch';
  /**
   * @minItems 1
   */
  channels: [Name, ...Name[]];
  labels?: string[];
  frame_count: number;
  /**
   * @minItems 2
   * @maxItems 2
   */
  range?: [number, number];
  revolutions?: number;
  seconds?: number;
  keyframes?: Keyframes;
  end?: 'loop' | 'stop';
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "panel".
 */
export interface Panel {
  label?: string;
  frame: Id | InputRef;
  camera?: Camera;
  reference: Reference;
  layers: Layer[];
  opacity?: Opacity;
  margin?: {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  };
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "inputRef".
 */
export interface InputRef {
  input: Id;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "reference".
 */
export interface Reference {
  sets: SetQuery;
  member:
    | {
        index: number;
      }
    | InputRef;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "trail".
 */
export interface Trail {
  fraction: number;
  taper?: {
    width?: number;
    opacity?: number;
  };
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "keyframed".
 */
export interface Keyframed {
  keyframes: Keyframes;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "colormapByChoice".
 */
export interface ColormapByChoice {
  input: Id;
  map: {
    [k: string]: ColormapName | undefined;
  };
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "layerClock".
 */
export interface LayerClock {
  channel: Name;
  /**
   * @minItems 2
   * @maxItems 2
   */
  range?: [number, number];
  keyframes?: Keyframes;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "box".
 */
export interface Box {
  fill?: Color;
  edge?: Color;
  edge_width?: number;
  pad?: number;
  radius?: number;
  opacity?: number;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "marker".
 */
export interface Marker {
  shape?: 'disc' | 'ring' | 'square' | 'diamond' | 'triangle' | 'star' | 'cross' | 'plus';
  size?: Size;
  color?: Color;
  edge?: Color;
  edge_width?: number | Keyframed;
  opacity?: Opacity;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "readout".
 */
export interface Readout {
  place: 'caption' | 'panel';
  parts: TextPart[];
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "state".
 */
export interface State {
  inputs?: {
    [k: string]: number | string | boolean | undefined;
  };
  clock: {
    channel: Name;
  };
  panels: {
    [k: string]:
      | {
          panel: Id;
          inputs?: {
            [k: string]: number | string | boolean | undefined;
          };
        }
      | undefined;
  };
  layout: Layout;
}
