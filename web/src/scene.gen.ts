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
 * via the `definition` "variable".
 */
export type Variable =
  | {
      kind: 'selector';
      by?: 'nearest' | 'index';
      parameter?: Name;
      default: number;
      scope?: 'scene' | 'panel';
    }
  | {
      kind: 'choice';
      /**
       * @minItems 1
       */
      values: [string, ...string[]];
      labels?: string[];
      default: string;
      scope?: 'scene' | 'panel';
    }
  | {
      kind: 'toggle';
      default: boolean;
      scope?: 'scene' | 'panel';
    };
/**
 * @minItems 1
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "keys".
 */
export type Keys = [
  [number | string, number | string] | [number | string, number | string, number | string],
  ...([number | string, number | string] | [number | string, number | string, number | string])[]
];
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "camera".
 */
export type Camera =
  | {
      kind: 'plane';
      plane?: 'xy' | 'xz' | 'yz';
      aspect?: 'equal' | 'free';
      /**
       * @minItems 1
       */
      keys?: [
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
      kind: 'orbit';
      projection?: 'orthographic' | 'perspective';
      up?: 'x' | 'y' | 'z';
      /**
       * @minItems 3
       * @maxItems 3
       */
      stretch?: [number, number, number];
      turn?: number;
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
export type StringValue = string | VarRef;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "layer".
 */
export type Layer =
  | {
      kind: 'track';
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
            edge_width?: number | Tween;
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
      context?: 'own' | 'driver';
      fit?: boolean;
      color?: ColorSpec;
      opacity?: Opacity;
      width?: number;
      highlight?: {
        var: Id;
        width?: number;
        opacity?: number;
        kernel?: {
          width: number;
          opacity: number;
        };
      };
      visible?: VarRef;
      clock?: LayerClock;
      line?: boolean;
      flat?: boolean;
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
      visible?: VarRef;
      clock?: LayerClock;
    }
  | {
      kind: 'outline';
      view: Id;
      color?: Color;
      opacity?: Opacity;
      width?: number;
      /**
       * @minItems 2
       * @maxItems 2
       */
      dash?: [number, number];
      min_size?: number;
      visible?: VarRef;
    }
  | {
      kind: 'body';
      body: Id;
      trail?: Trail;
      size?: number;
      visible?: VarRef;
      opacity?: Opacity;
    }
  | {
      kind: 'axes';
      span?: 'positive' | 'full' | 'box';
      visible?: VarRef;
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
      visible?: VarRef;
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
      visible?: VarRef;
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
      visible?: VarRef;
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
      count: number;
    }
  | VarRef;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "size".
 */
export type Size = number | Tween;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "opacity".
 */
export type Opacity = number | Tween;
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
      clip?: [number, number];
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
      clip?: [number, number];
    }
  | {
      channel: Name;
      /**
       * @minItems 1
       */
      steps: [number, ...number[]];
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
      var: Id;
      digits?: number;
      decimals?: number;
      grouping?: boolean;
      factor?: number;
      offset?: number;
      width?: number;
    }
  | {
      member: Name;
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
      clock: 'index' | 'steps' | 'value' | 'time';
      digits?: number;
      decimals?: number;
      grouping?: boolean;
      factor?: number;
      offset?: number;
      width?: number;
    }
  | {
      keys: Keys;
      digits?: number;
      decimals?: number;
      grouping?: boolean;
      factor?: number;
      offset?: number;
      width?: number;
    }
  | {
      steps: [number | string, number | string][];
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
      variable: Id;
      label: string;
      domain: SetQuery;
    }
  | {
      kind: 'tabs' | 'toggle';
      variable: Id;
      label: string;
    }
  | {
      kind: 'transport';
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
      keys?: Keys;
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
 * Structure of scene.tys, version 0.4. The rules that this schema cannot express are in tycho-scene.md.
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
  track_sets: {
    [k: string]: TrackSet | undefined;
  };
  variables?: {
    [k: string]: Variable | undefined;
  };
  clock: Clock;
  views: {
    [k: string]: View | undefined;
  };
  controls?: Control[];
  readouts?: Readout[];
  initial: State;
  stages?: {
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
 * via the `definition` "trackSet".
 */
export interface TrackSet {
  label?: string;
  frame: Id;
  tags?: {
    [k: string]: string | undefined;
  };
  attrs?: {
    [k: string]: number | undefined;
  };
  tracks: number;
  offsets: Name;
  positions: Name;
  channels?: {
    [k: string]:
      | {
          view: Name;
          interp?: 'linear' | 'hold';
          unit?: string;
        }
      | undefined;
  };
  parameters?: {
    [k: string]:
      | {
          view: Name;
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
  mode: 'fraction' | 'value';
  /**
   * @minItems 1
   */
  channels: [Name, ...Name[]];
  labels?: string[];
  steps: number;
  /**
   * @minItems 2
   * @maxItems 2
   */
  range?: [number, number];
  laps?: number;
  seconds?: number;
  keys?: Keys;
  end?: 'loop' | 'stop';
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "view".
 */
export interface View {
  label?: string;
  frame: Id | VarRef;
  camera?: Camera;
  driver: Driver;
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
 * via the `definition` "varRef".
 */
export interface VarRef {
  var: Id;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "driver".
 */
export interface Driver {
  sets: SetQuery;
  member:
    | {
        index: number;
      }
    | VarRef;
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
 * via the `definition` "tween".
 */
export interface Tween {
  keys: Keys;
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "colormapByChoice".
 */
export interface ColormapByChoice {
  var: Id;
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
  keys?: Keys;
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
  edge_width?: number | Tween;
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
  variables?: {
    [k: string]: number | string | boolean | undefined;
  };
  clock: {
    channel: Name;
  };
  panels: {
    [k: string]:
      | {
          view: Id;
          variables?: {
            [k: string]: number | string | boolean | undefined;
          };
        }
      | undefined;
  };
  layout: Layout;
}
