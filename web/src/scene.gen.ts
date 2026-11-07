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
 * via the `definition` "name".
 */
export type Name = string;
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "scalar".
 */
export type Scalar = number | Attr | ChannelRef;
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
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "camera".
 */
export type Camera =
  | {
      kind: 'plane';
      plane?: 'xy' | 'xz' | 'yz';
    }
  | {
      kind: 'orbit';
      projection?: 'orthographic' | 'perspective';
      up?: 'x' | 'y' | 'z';
    };
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
            size?: number;
          };
      before?: 'clamp' | 'hidden';
      after?: 'clamp' | 'hidden';
      color?: ColorSpec;
      opacity?: number;
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
    }
  | {
      kind: 'body';
      body: Id;
      trail?: Trail;
      size?: number;
      visible?: VarRef;
    }
  | {
      kind: 'axes';
      span?: 'positive' | 'full';
      visible?: VarRef;
    }
  | {
      kind: 'grid';
      labels?: boolean;
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
    };
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "colormapName".
 */
export type ColormapName = 'viridis' | 'plasma' | 'cividis' | 'blues' | 'reds';
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
    };

/**
 * Structure of scene.tys, version 0.3. The rules that this schema cannot express are in tycho-scene.md.
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
}
/**
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "theme".
 */
export interface Theme {
  background?: Color;
  foreground?: Color;
  grid?: Color;
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
    | Point
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
 * via the `definition` "readout".
 */
export interface Readout {
  place: 'caption' | 'panel';
  parts: (
    | string
    | {
        var: Id;
        digits?: number;
      }
    | {
        member: Name;
        digits?: number;
      }
    | {
        attr: Name;
        factor?: number;
        offset?: number;
        digits?: number;
      }
    | {
        channel: Name;
        digits?: number;
      }
    | {
        clock: 'index' | 'steps';
      }
  )[];
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
