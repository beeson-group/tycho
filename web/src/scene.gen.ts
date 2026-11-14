/**
 * Types for scene.tys, generated from spec/scene.schema.json by scripts/gen-types.mjs.
 * Do not edit. Run `npm run gen:types` after changing the schema.
 */

/**
 * A scalar is a number, an attribute, or a channel, and the field that holds it determines which forms are allowed. (rule `context-number`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "scalar".
 */
export type Scalar = number | Attr | ChannelRef;
/**
 * An input is a value that the person at the page can change, of kind parameter, choice, or toggle. (rule `input`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "input".
 */
export type Input =
  | {
      /**
       * The kind is "parameter".
       */
      kind: 'parameter';
      /**
       * The input holds a value of the parameter with this name, or the number of a member with the built-in parameter @index. (rule `index-channel`)
       */
      parameter: Name;
      /**
       * The value at the start is this finite number.
       */
      default: number;
      /**
       * With "shared", the default, the input has one value for the whole page, and with "per_panel" it has one value per shown panel. (rule `input-scope`)
       */
      scope?: 'shared' | 'per_panel';
    }
  | {
      /**
       * The kind is "choice".
       */
      kind: 'choice';
      /**
       * The strings that the input may hold are listed here, each once.
       *
       * @minItems 1
       */
      values: [string, ...string[]];
      /**
       * The text shown for each value is given here, one entry per value. The value itself is shown by default.
       */
      labels?: string[];
      /**
       * The value at the start is one of the values.
       */
      default: string;
      /**
       * With "shared", the default, the input has one value for the whole page, and with "per_panel" it has one value per shown panel. (rule `input-scope`)
       */
      scope?: 'shared' | 'per_panel';
    }
  | {
      /**
       * The kind is "toggle".
       */
      kind: 'toggle';
      /**
       * The value at the start is true or false.
       */
      default: boolean;
      /**
       * With "shared", the default, the input has one value for the whole page, and with "per_panel" it has one value per shown panel. (rule `input-scope`)
       */
      scope?: 'shared' | 'per_panel';
    };
/**
 * An identifier consists of ASCII letters, digits, underscores, dots, and hyphens, with at least one character. (rule `identifier`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "id".
 */
export type Id = string;
/**
 * A layer is one thing drawn in a panel, and its kind says what.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "layer".
 */
export type Layer =
  | {
      /**
       * The kind is "trajectories".
       */
      kind: 'trajectories';
      /**
       * The trajectories are taken from the set that this query resolves to. (rule `set-query`)
       */
      sets: SetQuery;
      /**
       * The members of the set that are drawn are selected here. (rule `members`)
       */
      members: MemberRef;
      /**
       * With "none", the default, the whole trajectory is drawn. With "grow", it grows to the moving point, and with "trail", a trail follows the point. (rule `panel`)
       */
      reveal?: 'none' | 'grow' | 'trail';
      /**
       * The trail is given here, and it is required when reveal is "trail".
       */
      trail?: Trail;
      /**
       * With a head, the moving point is drawn as a marker. True gives the default marker, and false or an absent head gives none. (rule `head`)
       */
      head?:
        | boolean
        | {
            /**
             * The head is drawn in this color, and in the color of the layer at this point by default.
             */
            color?: Color;
            /**
             * The width of the head is given in CSS pixels, or keyframed, and it is 9 by default.
             */
            size?: Size;
            /**
             * The shape is "disc", the default, "ring", "square", "diamond", "triangle", "star", "cross", or "plus".
             */
            shape?: 'disc' | 'ring' | 'square' | 'diamond' | 'triangle' | 'star' | 'cross' | 'plus';
            /**
             * A filled shape is outlined in this color when it is given.
             */
            edge?: Color;
            /**
             * The width of the outline, or of the stroke of a ring, a cross, or a plus, is given in CSS pixels. It is a sixth of the size by default.
             */
            edge_width?: number | Keyframed;
            /**
             * The opacity is in [0, 1], or keyframed, and 1 by default.
             */
            opacity?: Opacity;
            /**
             * A disc is drawn behind the head while the channel of the member is positive, e.g. the plume of a thruster.
             */
            glow?: {
              /**
               * The glow is shown while the channel with this name is positive, and the set carries it.
               */
              channel: Name;
              /**
               * The glow is drawn in this color, and in #d62728 by default.
               */
              color?: Color;
              /**
               * The diameter of the glow is given in CSS pixels, and it is 2.4 times the size of the head by default.
               */
              size?: number;
              /**
               * The opacity of the glow is in [0, 1], and it is 0.35 by default.
               */
              opacity?: number;
            };
          };
      /**
       * In mode epoch, "clamp", the default, holds a member at its first sample before it starts, and "hidden" hides it. (rule `before-after`)
       */
      before?: 'clamp' | 'hidden';
      /**
       * In mode epoch, "clamp", the default, holds a member at its last sample after it ends, and "hidden" hides it. (rule `before-after`)
       */
      after?: 'clamp' | 'hidden';
      /**
       * With "own", the default, each sample is transformed in its own context. With "reference", it is transformed in the context of the reference trajectory. (rule `read-from`)
       */
      read_from?: 'own' | 'reference';
      /**
       * With false, the layer is drawn but left out of the camera fit. The default is true.
       */
      fit?: boolean;
      /**
       * The color of the layer is the foreground of the theme by default.
       */
      color?: ColorSpec;
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
      /**
       * The width of the line is given in CSS pixels, and it is 1 by default.
       */
      width?: number;
      /**
       * One member is drawn more prominently, the one that an input of kind parameter selects. (rule `members`)
       */
      highlight?: {
        /**
         * The highlighted member is selected by the input of kind parameter with this id.
         */
        input: Id;
        /**
         * The width of the highlighted line is given in CSS pixels, and it is the width of the layer by default.
         */
        width?: number;
        /**
         * The opacity of the highlighted line is in [0, 1], and it is 1 by default.
         */
        opacity?: number;
        /**
         * The neighbors of the highlighted member are also brightened, with a Gaussian falloff in the parameter.
         */
        kernel?: {
          /**
           * The width of the kernel is a fraction of the extent of the parameter over the set, in (0, 1].
           */
          width: number;
          /**
           * The opacity at the center of the kernel is in [0, 1], and the opacity of the layer stays the floor.
           */
          opacity: number;
        };
      };
      /**
       * The layer is omitted while the toggle that this refers to is false. (rule `visible`)
       */
      visible?: InputRef;
      /**
       * With a layer clock, the fractions along are computed by a channel of the layer's own. (rule `layer-clock`)
       */
      clock?: LayerClock;
      /**
       * With false, only the heads are drawn, e.g. for a cloud of moving points. The default is true.
       */
      line?: boolean;
      /**
       * With true, each pixel that the lines cover is blended once at the opacity of the layer, so that overlaps do not build up. The default is false.
       */
      group_opacity?: boolean;
      /**
       * The line is dashed with dashes of on and gaps of off CSS pixels, given as [on, off].
       *
       * @minItems 2
       * @maxItems 2
       */
      dash?: [number, number];
      /**
       * Under a 2d camera, the area between the line and a base line is shaded where the line lies above the base.
       */
      fill?: {
        /**
         * The base line lies at this value of the second axis of the plane, and at 0 by default.
         */
        base?: number;
        /**
         * The fill is drawn in this color, and by default in the color of the layer when that is fixed, or in the foreground of the theme otherwise.
         */
        color?: Color;
        /**
         * The opacity of the fill is in [0, 1], and it is 0.25 by default.
         */
        opacity?: number;
      };
    }
  | {
      /**
       * The kind is "arrow".
       */
      kind: 'arrow';
      /**
       * The trajectories are taken from the set that this query resolves to. (rule `set-query`)
       */
      sets: SetQuery;
      /**
       * The members of the set that are drawn are selected here. (rule `members`)
       */
      members: MemberRef;
      /**
       * The components of the vector are read from the two or three channels with these names, in the frame of the set. The channel @index is not allowed. (rule `arrow`)
       *
       * @minItems 2
       * @maxItems 3
       */
      vector: [Name, Name] | [Name, Name, Name];
      /**
       * The arrow is the vector times this constant scalar, in units of the frame. The default is 1. (rule `arrow`)
       */
      scale?: ConstantScalar;
      /**
       * In mode epoch, "clamp", the default, holds a member at its first sample before it starts, and "hidden" hides it. (rule `before-after`)
       */
      before?: 'clamp' | 'hidden';
      /**
       * In mode epoch, "clamp", the default, holds a member at its last sample after it ends, and "hidden" hides it. (rule `before-after`)
       */
      after?: 'clamp' | 'hidden';
      /**
       * The arrow is drawn in this color, and in the foreground of the theme by default.
       */
      color?: Color;
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
      /**
       * The width of the shaft is given in CSS pixels, and it is 1 by default.
       */
      width?: number;
      /**
       * The arrowhead is a filled triangle at the tip, 0.8 times as wide as it is long.
       */
      head?: {
        /**
         * The length of the arrowhead is given in CSS pixels, and it is 10 by default.
         */
        size?: number;
      };
      /**
       * The layer is omitted while the toggle that this refers to is false. (rule `visible`)
       */
      visible?: InputRef;
      /**
       * With a layer clock, the fractions along are computed by a channel of the layer's own. (rule `layer-clock`)
       */
      clock?: LayerClock;
    }
  | {
      /**
       * The kind is "inset_box".
       */
      kind: 'inset_box';
      /**
       * The rectangle is the one shown by the first shown panel of the declared panel with this id, which has a 2d camera. (rule `inset-box`)
       */
      panel: Id;
      /**
       * The box is drawn in this color, and in the foreground of the theme by default.
       */
      color?: Color;
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
      /**
       * The width of the line is given in CSS pixels, and it is 1 by default.
       */
      width?: number;
      /**
       * The line is dashed with dashes of on and gaps of off CSS pixels, given as [on, off].
       *
       * @minItems 2
       * @maxItems 2
       */
      dash?: [number, number];
      /**
       * On the screen, the box is at least this many CSS pixels wide and tall, and 8 by default.
       */
      min_size?: number;
      /**
       * The layer is omitted while the toggle that this refers to is false. (rule `visible`)
       */
      visible?: InputRef;
    }
  | {
      /**
       * The kind is "body".
       */
      kind: 'body';
      /**
       * The body with this id is drawn.
       */
      body: Id;
      /**
       * With a trail, the path of the body over the trail of the reference trajectory is drawn as well. (rule `body-layer`)
       */
      trail?: Trail;
      /**
       * The diameter of the body, or the width of its image, is given in CSS pixels, and it is 8 by default.
       */
      size?: number;
      /**
       * The layer is omitted while the toggle that this refers to is false. (rule `visible`)
       */
      visible?: InputRef;
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
    }
  | {
      /**
       * The kind is "axes".
       */
      kind: 'axes';
      /**
       * With "full", both directions of each axis are drawn across the panel, with "positive" only the positive half-axes, and with "box" a box around the plot under a 2d camera. The default is "full" under a 2d camera and "positive" under a 3d camera.
       */
      span?: 'positive' | 'full' | 'box';
      /**
       * The layer is omitted while the toggle that this refers to is false. (rule `visible`)
       */
      visible?: InputRef;
      /**
       * The axes of the plane that carry tick numbers in a box, "x" and "y", are listed here. Both are listed by default.
       */
      ticks?: ('x' | 'y')[];
      /**
       * The height of the tick numbers of a box is given in CSS pixels, and it is 12 by default.
       */
      size?: number;
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
      /**
       * The two texts given here replace the titles of the axes of the frame, e.g. with a subscript.
       *
       * @minItems 2
       * @maxItems 2
       */
      titles?: [Text, Text];
    }
  | {
      /**
       * The kind is "grid".
       */
      kind: 'grid';
      /**
       * With true, the lines are numbered under a 2d camera. The default is true under a 2d camera and false under a 3d camera.
       */
      labels?: boolean;
      /**
       * The layer is omitted while the toggle that this refers to is false. (rule `visible`)
       */
      visible?: InputRef;
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
    }
  | {
      /**
       * The kind is "label".
       */
      kind: 'label';
      /**
       * The text is a string or a list of parts, read in the panel of the layer. (rule `timeline-parts`)
       */
      text: Text;
      /**
       * The anchor is a point, a member, or a fixed place on the screen. (rule `label`)
       */
      at: Anchor;
      /**
       * The text is drawn [dx, dy] CSS pixels from the anchor, with dy pointing down the screen. The default is [0, 0].
       *
       * @minItems 2
       * @maxItems 2
       */
      offset?: [number, number];
      /**
       * The text is aligned along the line at its "start", the default, its "center", or its "end".
       */
      align?: 'start' | 'center' | 'end';
      /**
       * The text is aligned vertically at the "top", "middle", or "bottom" of its box, or at the "alphabetic" baseline of its last line. The default is "middle".
       */
      baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
      /**
       * The height of the text is given in CSS pixels, and it is 13 by default.
       */
      size?: number;
      /**
       * The text is drawn in this color, and in the foreground of the theme by default.
       */
      color?: Color;
      /**
       * The weight of the font is "normal", the default, or "bold".
       */
      weight?: 'normal' | 'bold';
      /**
       * The spacing of lines is given as in matplotlib, and it is 1.2 by default.
       */
      linespacing?: number;
      /**
       * The text is drawn on a rectangle with this fill and edge.
       */
      box?: Box;
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
      /**
       * With a leader, a line is drawn from the anchor toward the text. True gives the default line.
       */
      leader?:
        | boolean
        | {
            /**
             * The leader is drawn in this color, and in the color of the text by default.
             */
            color?: Color;
            /**
             * The width of the leader is given in CSS pixels, and it is 1 by default.
             */
            width?: number;
          };
      /**
       * With a layer clock, the fractions along are computed by a channel of the layer's own. (rule `layer-clock`)
       */
      clock?: LayerClock;
      /**
       * The layer is omitted while the toggle that this refers to is false. (rule `visible`)
       */
      visible?: InputRef;
    }
  | {
      /**
       * The kind is "points".
       */
      kind: 'points';
      /**
       * The trajectories are taken from the set that this query resolves to. (rule `set-query`)
       */
      sets: SetQuery;
      /**
       * The members of the set that are drawn are selected here. (rule `members`)
       */
      members: MemberRef;
      /**
       * The samples are drawn with this marker, 4 CSS pixels wide in the foreground of the theme by default.
       */
      marker?: Marker;
      /**
       * With "none", the default, every sample is drawn. With "grow", the samples appear one after another as the clock passes them. (rule `points`)
       */
      reveal?: 'none' | 'grow';
      /**
       * In mode epoch, "clamp", the default, holds a member at its first sample before it starts, and "hidden" hides it. (rule `before-after`)
       */
      before?: 'clamp' | 'hidden';
      /**
       * In mode epoch, "clamp", the default, holds a member at its last sample after it ends, and "hidden" hides it. (rule `before-after`)
       */
      after?: 'clamp' | 'hidden';
      /**
       * With a layer clock, the fractions along are computed by a channel of the layer's own. (rule `layer-clock`)
       */
      clock?: LayerClock;
      /**
       * With false, the layer is drawn but left out of the camera fit. The default is true.
       */
      fit?: boolean;
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
      /**
       * The layer is omitted while the toggle that this refers to is false. (rule `visible`)
       */
      visible?: InputRef;
    };
/**
 * A name of a channel, a parameter, an attribute, or an array of the data container is a nonempty string.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "name".
 */
export type Name = string;
/**
 * A text is a string or a list of parts. A newline character starts a new line. (rule `plain-text`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "text".
 */
export type Text = string | TextPart[];
/**
 * A part of a text is a string, shown as it is, or a value, a subscript, or a superscript. (rule `timeline-parts`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "textPart".
 */
export type TextPart =
  | string
  | {
      /**
       * The value of the input with this id is shown.
       */
      input: Id;
      /**
       * The number is shown to this many significant digits, from 1 to 17. Without it, an integer is shown as it is and any other number to six significant digits.
       */
      digits?: number;
      /**
       * The number is shown with this many digits after the decimal point, from 0 to 17, in place of digits.
       */
      decimals?: number;
      /**
       * With true, the thousands of the integer part are separated by commas. The default is false.
       */
      grouping?: boolean;
      /**
       * The number is multiplied by this factor before it is shown, and 1 by default.
       */
      factor?: number;
      /**
       * This offset is added after the factor, and it is 0 by default.
       */
      offset?: number;
      /**
       * The number is padded with spaces on the left to this many characters, and 0 by default.
       */
      width?: number;
    }
  | {
      /**
       * The value of the parameter with this name is shown, and the name @index is accepted.
       */
      parameter: Name;
      /**
       * The number is shown to this many significant digits, from 1 to 17. Without it, an integer is shown as it is and any other number to six significant digits.
       */
      digits?: number;
      /**
       * The number is shown with this many digits after the decimal point, from 0 to 17, in place of digits.
       */
      decimals?: number;
      /**
       * With true, the thousands of the integer part are separated by commas. The default is false.
       */
      grouping?: boolean;
      /**
       * The number is multiplied by this factor before it is shown, and 1 by default.
       */
      factor?: number;
      /**
       * This offset is added after the factor, and it is 0 by default.
       */
      offset?: number;
      /**
       * The number is padded with spaces on the left to this many characters, and 0 by default.
       */
      width?: number;
    }
  | {
      /**
       * The value of the attribute with this name is shown.
       */
      attr: Name;
      /**
       * The number is shown to this many significant digits, from 1 to 17. Without it, an integer is shown as it is and any other number to six significant digits.
       */
      digits?: number;
      /**
       * The number is shown with this many digits after the decimal point, from 0 to 17, in place of digits.
       */
      decimals?: number;
      /**
       * With true, the thousands of the integer part are separated by commas. The default is false.
       */
      grouping?: boolean;
      /**
       * The number is multiplied by this factor before it is shown, and 1 by default.
       */
      factor?: number;
      /**
       * This offset is added after the factor, and it is 0 by default.
       */
      offset?: number;
      /**
       * The number is padded with spaces on the left to this many characters, and 0 by default.
       */
      width?: number;
    }
  | {
      /**
       * The value of the channel with this name is shown. The channel @index is not allowed. (rule `index-channel`)
       */
      channel: Name;
      /**
       * The number is shown to this many significant digits, from 1 to 17. Without it, an integer is shown as it is and any other number to six significant digits.
       */
      digits?: number;
      /**
       * The number is shown with this many digits after the decimal point, from 0 to 17, in place of digits.
       */
      decimals?: number;
      /**
       * With true, the thousands of the integer part are separated by commas. The default is false.
       */
      grouping?: boolean;
      /**
       * The number is multiplied by this factor before it is shown, and 1 by default.
       */
      factor?: number;
      /**
       * This offset is added after the factor, and it is 0 by default.
       */
      offset?: number;
      /**
       * The number is padded with spaces on the left to this many characters, and 0 by default.
       */
      width?: number;
    }
  | {
      /**
       * The value is the "frame_index", the "frame_count", the shared "value" of the clock channel, or the "time" of the timeline in seconds. (rule `timeline-parts`)
       */
      clock: 'frame_index' | 'frame_count' | 'value' | 'time';
      /**
       * The number is shown to this many significant digits, from 1 to 17. Without it, an integer is shown as it is and any other number to six significant digits.
       */
      digits?: number;
      /**
       * The number is shown with this many digits after the decimal point, from 0 to 17, in place of digits.
       */
      decimals?: number;
      /**
       * With true, the thousands of the integer part are separated by commas. The default is false.
       */
      grouping?: boolean;
      /**
       * The number is multiplied by this factor before it is shown, and 1 by default.
       */
      factor?: number;
      /**
       * This offset is added after the factor, and it is 0 by default.
       */
      offset?: number;
      /**
       * The number is padded with spaces on the left to this many characters, and 0 by default.
       */
      width?: number;
    }
  | {
      /**
       * The value shown is given by these keyframes.
       */
      keyframes: Keyframes;
      /**
       * The number is shown to this many significant digits, from 1 to 17. Without it, an integer is shown as it is and any other number to six significant digits.
       */
      digits?: number;
      /**
       * The number is shown with this many digits after the decimal point, from 0 to 17, in place of digits.
       */
      decimals?: number;
      /**
       * With true, the thousands of the integer part are separated by commas. The default is false.
       */
      grouping?: boolean;
      /**
       * The number is multiplied by this factor before it is shown, and 1 by default.
       */
      factor?: number;
      /**
       * This offset is added after the factor, and it is 0 by default.
       */
      offset?: number;
      /**
       * The number is padded with spaces on the left to this many characters, and 0 by default.
       */
      width?: number;
    }
  | {
      /**
       * The pairs [t, text] are given with nondecreasing times t in seconds of the timeline.
       */
      timed_text: [number | string, number | string][];
    }
  | {
      /**
       * This text is set as a subscript at 0.7 times the size, and as plain text in a readout.
       */
      sub: string;
    }
  | {
      /**
       * This text is set as a superscript at 0.7 times the size, and as plain text in a readout.
       */
      sup: string;
    };
/**
 * A control is a widget on the page that sets an input or drives the clock. (rule `control`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "control".
 */
export type Control =
  | {
      /**
       * The kind is "slider".
       */
      kind: 'slider';
      /**
       * The slider sets the input of kind parameter with this id.
       */
      input: Id;
      /**
       * The name shown beside the slider is plain text.
       */
      label: string;
      /**
       * The slider stops at the distinct values of the parameter over the sets that this query matches.
       */
      domain: SetQuery;
    }
  | {
      /**
       * The kind is "tabs" or "toggle".
       */
      kind: 'tabs' | 'toggle';
      /**
       * The control sets the input with this id.
       */
      input: Id;
      /**
       * The name shown beside the control is plain text.
       */
      label: string;
    }
  | {
      /**
       * The kind is "playback".
       */
      kind: 'playback';
    };
/**
 * An overlay is a text or a legend drawn over the whole panel area.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "overlay".
 */
export type Overlay =
  | {
      /**
       * The kind is "text".
       */
      kind: 'text';
      /**
       * The text is a string or a list of parts. (rule `timeline-parts`)
       */
      text: Text;
      /**
       * The text is placed at [fx, fy], the fractions of the width and the height of the panel area.
       *
       * @minItems 2
       * @maxItems 2
       */
      at: [number, number];
      /**
       * The text is aligned along the line at its "start", the default, its "center", or its "end".
       */
      align?: 'start' | 'center' | 'end';
      /**
       * The text is aligned vertically at the "top", "middle", or "bottom" of its box, or at the "alphabetic" baseline of its last line. The default is "middle".
       */
      baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
      /**
       * The height of the text is given in CSS pixels, and it is 13 by default.
       */
      size?: number;
      /**
       * The text is drawn in this color, and in the foreground of the theme by default.
       */
      color?: Color;
      /**
       * The weight of the font is "normal", the default, or "bold".
       */
      weight?: 'normal' | 'bold';
      /**
       * The spacing of lines is given as in matplotlib, and it is 1.2 by default.
       */
      linespacing?: number;
      /**
       * The text is drawn on a rectangle with this fill and edge.
       */
      box?: Box;
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
    }
  | {
      /**
       * The kind is "legend".
       */
      kind: 'legend';
      /**
       * The legend is placed at [fx, fy], the fractions of the width and the height of the panel area.
       *
       * @minItems 2
       * @maxItems 2
       */
      at: [number, number];
      /**
       * The entries fill the columns from the top down.
       */
      entries: {
        /**
         * The label is a string, or a list of strings and subscript and superscript parts.
         */
        label:
          | string
          | (
              | string
              | {
                  /**
                   * This text is set as a subscript.
                   */
                  sub: string;
                }
              | {
                  /**
                   * This text is set as a superscript.
                   */
                  sup: string;
                }
            )[];
        /**
         * The entry is drawn as a short line.
         */
        line?: {
          /**
           * The line is drawn in this color.
           */
          color?: Color;
          /**
           * The width of the line is given in CSS pixels, and it is 2 by default.
           */
          width?: number;
          /**
           * The line is dashed with dashes of on and gaps of off CSS pixels, given as [on, off].
           *
           * @minItems 2
           * @maxItems 2
           */
          dash?: [number, number];
          /**
           * The opacity of the line is in [0, 1], and it is 1 by default.
           */
          opacity?: number;
        };
        /**
         * The entry is drawn as this marker.
         */
        marker?: Marker;
        /**
         * The entry is drawn as short lines side by side in these colors, e.g. one per member of a family.
         *
         * @minItems 1
         */
        colors?: [Color, ...Color[]];
      }[];
      /**
       * The number of entries per row is all of them by default.
       */
      columns?: number;
      /**
       * The height of the text is given in CSS pixels, and it is 13 by default.
       */
      size?: number;
      /**
       * The text is drawn in this color, and in the foreground of the theme by default.
       */
      color?: Color;
      /**
       * The legend is aligned at its "start", "center", the default, or "end".
       */
      align?: 'start' | 'center' | 'end';
      /**
       * The legend is aligned vertically at its "top", the default, "middle", or "bottom", or at the "alphabetic" baseline.
       */
      baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
      /**
       * The opacity is in [0, 1], or keyframed, and 1 by default.
       */
      opacity?: Opacity;
      /**
       * The length of the line of an entry is given in units of the size, and it is 2 by default.
       */
      handle_length?: number;
      /**
       * The gap between the line and the label is given in units of the size, and it is 0.8 by default.
       */
      handle_pad?: number;
      /**
       * The gap between columns is given in units of the size, and it is 2 by default.
       */
      column_spacing?: number;
    };
/**
 * A fixed color is written #rrggbb, with two hexadecimal digits each for red, green, and blue.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "color".
 */
export type Color = string;
/**
 * A constant scalar is a number or an attribute, and it does not change along a trajectory. (rule `context-number`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "constantScalar".
 */
export type ConstantScalar = number | Attr;
/**
 * A point is given by three scalars, its coordinates x, y, and z.
 *
 * @minItems 3
 * @maxItems 3
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "point".
 */
export type Point = [ConstantScalar, ConstantScalar, ConstantScalar];
/**
 * A string is given as it is or read from an input of kind choice.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "stringValue".
 */
export type StringValue = string | InputRef;
/**
 * A set query is the way a scene refers to a trajectory set, by its id or by its tags. (rule `set-query`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "setQuery".
 */
export type SetQuery =
  | {
      /**
       * The query matches the trajectory set with this id.
       */
      set: Id;
    }
  | {
      /**
       * The query matches every trajectory set whose tags contain all the given pairs. A value may be read from an input of kind choice.
       */
      tags: {
        [k: string]: StringValue | undefined;
      };
    };
/**
 * A member reference says which trajectories of a set are drawn: "all", one by index, an evenly spaced selection, or the one that an input of kind parameter selects. (rule `members`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "memberRef".
 */
export type MemberRef =
  | 'all'
  | {
      /**
       * The trajectory with this number, counted from 0, is selected. A number at or past the count of trajectories is an error. (rule `members`)
       */
      index: number;
    }
  | {
      /**
       * About this many trajectories are selected, and every trajectory when it is at least the count. (rule `members`)
       */
      evenly_spaced: number;
    }
  | InputRef;
/**
 * A colormap is named after its matplotlib equivalent.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "colormapName".
 */
export type ColormapName = 'viridis' | 'plasma' | 'cividis' | 'blues' | 'reds';
/**
 * A color is a fixed color, a colormap over a parameter or a channel, or a color by thresholds of a channel.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "colorSpec".
 */
export type ColorSpec =
  | Color
  | {
      /**
       * The colormap is taken over the parameter with this name, which the set of the layer carries.
       */
      parameter: Name;
      /**
       * The colormap is a name or is picked by an input of kind choice.
       */
      colormap: ColormapName | ColormapByChoice;
      /**
       * This interval of values is mapped onto the colormap. It is the extent of the values over the set by default.
       *
       * @minItems 2
       * @maxItems 2
       */
      range?: [number, number];
      /**
       * The part [a, b] of the colormap onto which the range is mapped lies within [0, 1], and it is [0, 1] by default.
       *
       * @minItems 2
       * @maxItems 2
       */
      truncate?: [number, number];
    }
  | {
      /**
       * The colormap is taken over the channel with this name, which the set of the layer carries.
       */
      channel: Name;
      /**
       * The colormap is a name or is picked by an input of kind choice.
       */
      colormap: ColormapName | ColormapByChoice;
      /**
       * This interval of values is mapped onto the colormap. It is the extent of the values over the set by default.
       *
       * @minItems 2
       * @maxItems 2
       */
      range?: [number, number];
      /**
       * The part [a, b] of the colormap onto which the range is mapped lies within [0, 1], and it is [0, 1] by default.
       *
       * @minItems 2
       * @maxItems 2
       */
      truncate?: [number, number];
    }
  | {
      /**
       * The thresholds apply to the channel with this name, which the set of the layer carries.
       */
      channel: Name;
      /**
       * The thresholds are given in increasing order.
       *
       * @minItems 1
       */
      thresholds: [number, ...number[]];
      /**
       * The colors are given one more than the thresholds.
       *
       * @minItems 2
       */
      colors: [Color, Color, ...Color[]];
    };
/**
 * The camera is the way a panel shows its display frame, as a flat picture of one plane or as a three-dimensional picture.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "camera".
 */
export type Camera =
  | {
      /**
       * The kind is "2d".
       */
      kind: '2d';
      /**
       * The picture shows the plane "xy", the default, "xz", or "yz". (rule `panel`)
       */
      plane?: 'xy' | 'xz' | 'yz';
      /**
       * With "equal", the default, one unit is as long across the panel as up it. With "free", the two axes are scaled separately.
       */
      aspect?: 'equal' | 'free';
      /**
       * The window that the panel shows is given by camera keyframes over the timeline. (rule `camera-keyframes`)
       *
       * @minItems 1
       */
      keyframes?: [
        {
          /**
           * The time of the keyframe is given in seconds of the timeline.
           */
          at: number;
          /**
           * The extent of the window along the first axis of the plane is given in units of the display frame.
           */
          width: number;
          /**
           * The extent of the window along the second axis is given only under "aspect": "free", and the aspect ratio of the panel gives it otherwise.
           */
          height?: number;
          /**
           * The center of the window is given by two coordinates along the axes of the plane.
           *
           * @minItems 2
           * @maxItems 2
           */
          center?: [number, number];
          /**
           * The center follows the mean of the moving points of these targets, plus the offset. (rule `camera-keyframes`)
           *
           * @minItems 1
           */
          follow?: [
            {
              /**
               * The target is a member of the trajectories layer at this index of the layers of the panel.
               */
              layer: number;
              /**
               * The target is the member with this number in the set of the layer.
               */
              member: number;
            },
            ...{
              /**
               * The target is a member of the trajectories layer at this index of the layers of the panel.
               */
              layer: number;
              /**
               * The target is the member with this number in the set of the layer.
               */
              member: number;
            }[]
          ];
          /**
           * This offset is added to the center of a follow keyframe, and it is [0, 0] by default.
           *
           * @minItems 2
           * @maxItems 2
           */
          offset?: [number, number];
          /**
           * The window travels to this keyframe from the one before by this ease, and linearly by default. (rule `ease`)
           */
          ease?: Ease;
        },
        ...{
          /**
           * The time of the keyframe is given in seconds of the timeline.
           */
          at: number;
          /**
           * The extent of the window along the first axis of the plane is given in units of the display frame.
           */
          width: number;
          /**
           * The extent of the window along the second axis is given only under "aspect": "free", and the aspect ratio of the panel gives it otherwise.
           */
          height?: number;
          /**
           * The center of the window is given by two coordinates along the axes of the plane.
           *
           * @minItems 2
           * @maxItems 2
           */
          center?: [number, number];
          /**
           * The center follows the mean of the moving points of these targets, plus the offset. (rule `camera-keyframes`)
           *
           * @minItems 1
           */
          follow?: [
            {
              /**
               * The target is a member of the trajectories layer at this index of the layers of the panel.
               */
              layer: number;
              /**
               * The target is the member with this number in the set of the layer.
               */
              member: number;
            },
            ...{
              /**
               * The target is a member of the trajectories layer at this index of the layers of the panel.
               */
              layer: number;
              /**
               * The target is the member with this number in the set of the layer.
               */
              member: number;
            }[]
          ];
          /**
           * This offset is added to the center of a follow keyframe, and it is [0, 0] by default.
           *
           * @minItems 2
           * @maxItems 2
           */
          offset?: [number, number];
          /**
           * The window travels to this keyframe from the one before by this ease, and linearly by default. (rule `ease`)
           */
          ease?: Ease;
        }[]
      ];
    }
  | {
      /**
       * The kind is "3d".
       */
      kind: '3d';
      /**
       * With "perspective", the default, far objects look smaller. With "orthographic", parallel lines stay parallel.
       */
      projection?: 'orthographic' | 'perspective';
      /**
       * The axis of the display frame that points up the screen is "x", "y", or "z", the default.
       */
      up?: 'x' | 'y' | 'z';
      /**
       * Every position is multiplied by these three positive factors along x, y, and z, which are 1 by default.
       *
       * @minItems 3
       * @maxItems 3
       */
      stretch?: [number, number, number];
      /**
       * The camera is turned about its up axis by this many degrees over each loop, and by 0 by default.
       */
      auto_rotate?: number;
    };
/**
 * A layout node holds one shown panel or splits its area into two parts.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "layout".
 */
export type Layout =
  | {
      /**
       * The kind is "panel".
       */
      kind: 'panel';
      /**
       * The leaf holds the shown panel with this id.
       */
      id: Id;
    }
  | {
      /**
       * The kind is "split".
       */
      kind: 'split';
      /**
       * With "row", the parts are side by side, and with "col" one is above the other.
       */
      dir: 'row' | 'col';
      /**
       * The first part takes this fraction of the area, in (0, 1).
       */
      ratio: number;
      /**
       * The first part is given by this node.
       */
      a: Layout;
      /**
       * The second part is given by this node.
       */
      b: Layout;
      /**
       * The ratio is given by keyframes over the timeline, with values in [0, 1], and a part whose share is 0 is not drawn.
       */
      keyframes?: Keyframes;
    };
/**
 * An ease is the way a value travels to a keyframe from the one before: "linear", "smooth", "in", "out", "in-out", or "hold". (rule `ease`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "ease".
 */
export type Ease = 'linear' | 'smooth' | 'in' | 'out' | 'in-out' | 'hold';
/**
 * A list of keyframes is written [t, v] or [t, v, ease] each, with the time t in seconds of the timeline. The times are nondecreasing. (rule `keyframes`)
 *
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
 * An opacity is a number in [0, 1] or a keyframed value whose values lie in [0, 1]. (rule `timeline`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "opacity".
 */
export type Opacity = number | Keyframed;
/**
 * A size is a positive number of CSS pixels or a keyframed value whose values are positive. (rule `timeline`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "size".
 */
export type Size = number | Keyframed;
/**
 * An anchor is the place at which a label is written. (rule `label`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "anchor".
 */
export type Anchor =
  | {
      /**
       * The point is given by three coordinates.
       *
       * @minItems 3
       * @maxItems 3
       */
      point: [number, number, number];
      /**
       * The point is given in the frame with this id, and in the display frame by default.
       */
      frame?: Id;
    }
  | {
      /**
       * The member is taken from the set that this query resolves to. (rule `set-query`)
       */
      sets: SetQuery;
      /**
       * The member with this number is followed.
       */
      member: number;
    }
  | {
      /**
       * The place is given as [fx, fy], the fractions of the width from the left and of the height from the top.
       *
       * @minItems 2
       * @maxItems 2
       */
      screen: [number, number];
    };

/**
 * Structure of scene.tys, version 0.5. The rules that this schema cannot express are in tycho-scene.md.
 */
export interface Scene {
  /**
   * The format is always the string "tycho-scene". (rule `scene`)
   */
  format: 'tycho-scene';
  /**
   * The version of the scene format is written as "major.minor", e.g. "0.5". (rule `version`)
   */
  version: string;
  /**
   * The features that the scene uses are listed here, so that a runtime that does not implement one rejects the scene. (rule `version`)
   */
  requires?: string[];
  /**
   * The program that wrote the scene is named here, e.g. pytycho with its version.
   */
  generator?: string;
  /**
   * The title of the page is plain text. (rule `plain-text`)
   */
  title?: string;
  /**
   * The colors and the font of the page are given here.
   */
  theme?: Theme;
  /**
   * The frames of the scene are declared here by id, and together they form one tree. (rule `frame`)
   */
  frames: {
    [k: string]: Frame | undefined;
  };
  /**
   * The bodies, i.e. named points such as the primary and the secondary, are declared here by id. (rule `body`)
   */
  bodies?: {
    [k: string]: Body | undefined;
  };
  /**
   * The trajectory sets of the scene are declared here by id. (rule `trajectory-set`)
   */
  trajectory_sets: {
    [k: string]: TrajectorySet | undefined;
  };
  /**
   * The inputs, i.e. the values that the person at the page can change, are declared here by id. (rule `input`)
   */
  inputs?: {
    [k: string]: Input | undefined;
  };
  /**
   * The clock, i.e. the time of the animation shared by every panel, is described here. (rule `clock`)
   */
  clock: Clock;
  /**
   * The panels that a page may show are declared here by id. (rule `panel`)
   */
  panels: {
    [k: string]: Panel | undefined;
  };
  /**
   * The controls are the widgets on the page that set an input or drive the clock. (rule `control`)
   */
  controls?: Control[];
  /**
   * The readouts are the texts on the page that show current values.
   */
  readouts?: Readout[];
  /**
   * The state at the start, with the panels shown and the values of the inputs, is given here. (rule `state`)
   */
  initial: State;
  /**
   * The steps are the named times of the timeline at which a presentation stops. (rule `steps`)
   */
  steps?: {
    /**
     * The step is found by this identifier, which differs from the ids of the other steps. (rule `identifier`)
     */
    id: Id;
    /**
     * The time of the step is given in seconds of the timeline, within one loop. (rule `steps`)
     */
    at: number;
    /**
     * The name of the step is plain text, and it may be left out.
     */
    label?: string;
  }[];
  /**
   * The overlays are texts and legends drawn over the whole panel area rather than in one panel.
   */
  overlays?: Overlay[];
}
/**
 * A frame is a coordinate system, defined against its parent by an origin, a rotation, and a scale. The root frame has none of them. (rule `transform`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "frame".
 */
export interface Frame {
  /**
   * The name shown for the frame is plain text, and it does not affect any computation.
   */
  label?: string;
  /**
   * The three axis labels, e.g. ["x", "y", "z"], are used as the titles of the axes.
   *
   * @minItems 3
   * @maxItems 3
   */
  axes?: [string, string, string];
  /**
   * The unit label, e.g. "DU", is appended to the titles of the axes.
   */
  unit?: string;
  /**
   * The frame is defined against the frame with this id, and only the root frame lacks a parent. (rule `frame`)
   */
  parent?: Id;
  /**
   * The origin of the frame is given in the coordinates of the parent, as three scalars or at a body. It is 0 by default. (rule `origin`)
   */
  origin?:
    | [Scalar, Scalar, Scalar]
    | {
        /**
         * The origin is placed at the body with this id.
         */
        body: Id;
      };
  /**
   * The axes of the frame are turned against those of the parent by an angle about one axis. Without a rotation, the axes are parallel. (rule `transform`)
   */
  rotation?: {
    /**
     * The rotation is made about this axis of the parent.
     */
    axis: 'x' | 'y' | 'z';
    /**
     * The angle is given in radians, in the right-handed sense, so that a point fixed in the parent appears in the frame rotated by this angle. (rule `transform`)
     */
    angle: Scalar;
  };
  /**
   * One parent unit is this many units of the frame. The scale is 1 by default, and it is never zero. (rule `origin`)
   */
  scale?: Scalar;
}
/**
 * An attribute scalar has the value factor * attrs[attr] + offset, where attrs[attr] is the attribute of the trajectory set in context. (rule `context-number`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "attr".
 */
export interface Attr {
  /**
   * The attribute is read by this name from the attrs of the trajectory set in context.
   */
  attr: Name;
  /**
   * The attribute is multiplied by this factor, which is 1 by default.
   */
  factor?: number;
  /**
   * This offset is added after the factor, and it is 0 by default.
   */
  offset?: number;
}
/**
 * A channel scalar has the value of the channel at the sample in context, hence it changes along the trajectory. (rule `context-number`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "channelRef".
 */
export interface ChannelRef {
  /**
   * The channel is read by this name from the trajectory set in context.
   */
  channel: Name;
}
/**
 * A body is a named point, e.g. a primary of the three-body problem, without a radius or a shape. (rule `body`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "body".
 */
export interface Body {
  /**
   * The name shown for the body is plain text.
   */
  label?: string;
  /**
   * The position of the body is given in the frame with this id. (rule `body`)
   */
  frame: Id;
  /**
   * The position is given by three constant scalars in the frame of the body. (rule `body`)
   */
  position: Point;
  /**
   * The body is drawn in this color, and in the foreground of the theme by default.
   */
  color?: Color;
  /**
   * A uint8 array of the data container with this name holds a PNG, JPEG, or WebP image, which is drawn in place of the disc of the body.
   */
  image?: Name;
}
/**
 * A trajectory set holds trajectories that share a frame and a meaning, e.g. the members of a family of periodic orbits. (rule `trajectory-set`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "trajectorySet".
 */
export interface TrajectorySet {
  /**
   * The name of the set is plain text. It is written by pytycho and not drawn by the runtime.
   */
  label?: string;
  /**
   * The positions of the set are given in the frame with this id.
   */
  frame: Id;
  /**
   * The tags label the whole set, each a string value under a name, e.g. "family": "7". A set query finds sets by them. (rule `set-query`)
   */
  tags?: {
    [k: string]: string | undefined;
  };
  /**
   * The attributes are numbers of the whole set, e.g. "mu": 0.01215. (rule `context-number`)
   */
  attrs?: {
    [k: string]: number | undefined;
  };
  /**
   * The number of trajectories in the set is at least 1.
   */
  trajectories: number;
  /**
   * A uint32 array of shape (trajectories + 1,) with this name marks where each trajectory begins in the arrays of the set. Each trajectory has at least two samples. (rule `two-samples`)
   */
  offsets: Name;
  /**
   * A float array of shape (S, 2) or (S, 3) with this name holds the position of every sample in the frame of the set, where S is the total number of samples. (rule `trajectory-set`)
   */
  positions: Name;
  /**
   * The channels are quantities stored at every sample, e.g. the time or the true anomaly, declared here by name. The name @index is reserved. (rule `index-channel`)
   */
  channels?: {
    [k: string]:
      | {
          /**
           * An array of shape (S,) with this name holds one value of the channel per sample.
           */
          array: Name;
          /**
           * The value of the channel between samples is "linear", the default, or "hold", which keeps the value of the earlier sample. Only a channel part of a text reads it. (rule `timeline-parts`)
           */
          interp?: 'linear' | 'hold';
          /**
           * The unit of the channel is plain text, e.g. "TU". It is written by pytycho and not drawn by the runtime.
           */
          unit?: string;
        }
      | undefined;
  };
  /**
   * The parameters are numbers stored once per trajectory, e.g. the Jacobi constant of each member, declared here by name. The name @index is reserved. (rule `index-channel`)
   */
  parameters?: {
    [k: string]:
      | {
          /**
           * An array of shape (trajectories,) with this name holds one finite value of the parameter per trajectory.
           */
          array: Name;
          /**
           * The name shown for the parameter, e.g. in the title of a colorbar, is plain text. The name of the parameter is shown by default.
           */
          label?: string;
          /**
           * The unit of the parameter is plain text, and it is appended to the title of a colorbar over the parameter.
           */
          unit?: string;
        }
      | undefined;
  };
  /**
   * With true, each trajectory is declared periodic, i.e. its last sample is the first sample again one period later. The default is false. (rule `periodic`)
   */
  periodic?: boolean;
}
/**
 * A declared panel is one picture that a page may show, with a display frame, a camera, a reference trajectory, and layers. (rule `panel`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "panel".
 */
export interface Panel {
  /**
   * The name shown in the header of the panel is plain text, and the id of the panel by default.
   */
  label?: string;
  /**
   * The display frame, in which everything is drawn, is given by a frame id or by an input whose values are frame ids.
   */
  frame: Id | InputRef;
  /**
   * The camera is the way the panel shows the display frame.
   */
  camera?: Camera;
  /**
   * The reference trajectory of the panel is given here.
   */
  reference: Reference;
  /**
   * The layers are drawn in the order of this list, and a label layer is drawn above the others.
   */
  layers: Layer[];
  /**
   * Every shown panel of this declared panel is faded by this opacity, in [0, 1] or keyframed, and 1 by default.
   */
  opacity?: Opacity;
  /**
   * The camera does not draw into these fractions of the height or the width of the panel, e.g. to leave room for tick numbers.
   */
  margin?: {
    /**
     * The margin at the top is a fraction of the height of the panel, and 0 by default.
     */
    top?: number;
    /**
     * The margin at the right is a fraction of the width of the panel, and 0 by default.
     */
    right?: number;
    /**
     * The margin at the bottom is a fraction of the height of the panel, and 0 by default.
     */
    bottom?: number;
    /**
     * The margin at the left is a fraction of the width of the panel, and 0 by default.
     */
    left?: number;
  };
}
/**
 * A value is read from an input by its id. (rule `input-scope`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "inputRef".
 */
export interface InputRef {
  /**
   * The value is read from the input with this id. (rule `input`)
   */
  input: Id;
}
/**
 * A keyframed value is the value that its keyframes give at each time of the timeline. (rule `keyframes`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "keyframed".
 */
export interface Keyframed {
  /**
   * The value is given by these keyframes. (rule `keyframes`)
   */
  keyframes: Keyframes;
}
/**
 * A readout is a text that shows current values, read at the reference trajectory.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "readout".
 */
export interface Readout {
  /**
   * With "panel", the readout is shown in each shown panel, and with "caption" it is shown once below the panels.
   */
  place: 'caption' | 'panel';
  /**
   * The text is joined from these parts, without a format string. (rule `timeline-parts`)
   */
  parts: TextPart[];
}
/**
 * The theme gives the colors and the font of the page.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "theme".
 */
export interface Theme {
  /**
   * The background color of the page is #000000 by default.
   */
  background?: Color;
  /**
   * The foreground color is used for text, axes, and every line without a color of its own, and it is #d8d8d8 by default.
   */
  foreground?: Color;
  /**
   * The color of the lines of a grid layer is #262626 by default.
   */
  grid?: Color;
  /**
   * A CSS font family is used for every text of the page and of a video.
   */
  font?: string;
  /**
   * The color of the gutters between panels in a video is a blend of the foreground and the background by default.
   */
  gutter?: Color;
}
/**
 * The colormap is picked by the panel's value of an input of kind choice.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "colormapByChoice".
 */
export interface ColormapByChoice {
  /**
   * The colormap is picked by the value of the input of kind choice with this id.
   */
  input: Id;
  /**
   * Every value of the choice, and only these values, is given a colormap name.
   */
  map: {
    [k: string]: ColormapName | undefined;
  };
}
/**
 * The clock is the time of the animation, shared by every panel, so that all panels move together. (rule `clock`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "clock".
 */
export interface Clock {
  /**
   * In mode "fraction", every trajectory runs from its first to its last sample in one loop. In mode "epoch", every trajectory shows the same value of the clock channel. (rule `clock-mode`)
   */
  mode: 'fraction' | 'epoch';
  /**
   * The channels that may be the clock channel are listed here, and the person at the page switches among them with the playback control. (rule `monotone-clock-channel`)
   *
   * @minItems 1
   */
  channels: [Name, ...Name[]];
  /**
   * The text shown for each clock channel is given here, one entry per channel.
   */
  labels?: string[];
  /**
   * The number of frame indices in one loop is an integer of at least 1. (rule `clock`)
   */
  frame_count: number;
  /**
   * In mode epoch, the clock channel runs through this range [a, b] of values over one loop. (rule `clock-mode`)
   *
   * @minItems 2
   * @maxItems 2
   */
  range?: [number, number];
  /**
   * In mode fraction, one loop covers this many revolutions of every periodic set. The default is 1. (rule `revolutions`)
   */
  revolutions?: number;
  /**
   * The length of one loop is given in seconds at playback speed 1, and it is 8 seconds per revolution by default.
   */
  seconds?: number;
  /**
   * In mode epoch, the shared value of the clock channel is given by keyframes over the timeline, in place of a range. (rule `clock-keyframes`)
   */
  keyframes?: Keyframes;
  /**
   * With "loop", the default, the next loop starts at the end of a loop. With "stop", playback stops there. (rule `steps`)
   */
  end?: 'loop' | 'stop';
}
/**
 * A trail of fixed length follows the moving point. (rule `trail-wrap`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "trail".
 */
export interface Trail {
  /**
   * The length of the trail is a fraction of the whole loop, in (0, 1]. (rule `panel`)
   */
  fraction: number;
  /**
   * The width and the opacity fall linearly from the head to these fractions of themselves at the tail.
   */
  taper?: {
    /**
     * The width at the tail is this fraction of the width at the head, in [0, 1], and 0.25 by default.
     */
    width?: number;
    /**
     * The opacity at the tail is this fraction of the opacity at the head, in [0, 1], and 0.35 by default.
     */
    opacity?: number;
  };
}
/**
 * The reference trajectory is the one trajectory that a panel follows, at which the bodies and the readouts of the panel are placed and read.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "reference".
 */
export interface Reference {
  /**
   * The reference trajectory is taken from the set that this query resolves to. (rule `set-query`)
   */
  sets: SetQuery;
  /**
   * The reference trajectory is selected by its number or by an input of kind parameter. (rule `members`)
   */
  member:
    | {
        /**
         * The trajectory with this number, counted from 0, is selected.
         */
        index: number;
      }
    | InputRef;
}
/**
 * A state is everything that the person at the page can change, i.e. the shown panels, the values of the inputs, and the clock channel. (rule `state`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "state".
 */
export interface State {
  /**
   * The values of the shared inputs are given by input id, and an input without a value takes its default. (rule `input-scope`)
   */
  inputs?: {
    [k: string]: number | string | boolean | undefined;
  };
  /**
   * The clock channel of the state is given here.
   */
  clock: {
    /**
     * The clock channel is the one with this name, one of the channels of the clock. (rule `clock`)
     */
    channel: Name;
  };
  /**
   * The shown panels are given by id, each with its declared panel and its values of the per-panel inputs.
   */
  panels: {
    [k: string]:
      | {
          /**
           * The shown panel shows the declared panel with this id.
           */
          panel: Id;
          /**
           * The values of the per-panel inputs in this shown panel are given by input id. (rule `input-scope`)
           */
          inputs?: {
            [k: string]: number | string | boolean | undefined;
          };
        }
      | undefined;
  };
  /**
   * The shown panels are arranged by this tree of layout nodes, which holds each of them once.
   */
  layout: Layout;
}
/**
 * With a layer clock, a layer computes its fractions along in mode epoch by a channel of its own, through a range or keyframes. (rule `layer-clock`)
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "layerClock".
 */
export interface LayerClock {
  /**
   * The fractions along are computed by the channel with this name.
   */
  channel: Name;
  /**
   * The channel runs through this range [a, b] of values over one loop. (rule `clock-mode`)
   *
   * @minItems 2
   * @maxItems 2
   */
  range?: [number, number];
  /**
   * The shared value of the channel is given by keyframes over the timeline. (rule `clock-keyframes`)
   */
  keyframes?: Keyframes;
}
/**
 * A marker is a shape drawn at a point, as matplotlib draws a marker.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "marker".
 */
export interface Marker {
  /**
   * The shape is "disc", the default, "ring", "square", "diamond", "triangle", "star", "cross", or "plus".
   */
  shape?: 'disc' | 'ring' | 'square' | 'diamond' | 'triangle' | 'star' | 'cross' | 'plus';
  /**
   * The width of the shape is given in CSS pixels, or keyframed. It is 9 for a head and 4 for a points layer by default.
   */
  size?: Size;
  /**
   * A filled shape is filled with this color, and a ring, a cross, or a plus is stroked with it. It is the color of the layer for a head, and the foreground of the theme for a points layer, by default.
   */
  color?: Color;
  /**
   * A filled shape is outlined in this color when it is given.
   */
  edge?: Color;
  /**
   * The width of the outline, or of the stroke of a ring, a cross, or a plus, is given in CSS pixels, or keyframed. It is a sixth of the size by default.
   */
  edge_width?: number | Keyframed;
  /**
   * The opacity is in [0, 1], or keyframed, and 1 by default.
   */
  opacity?: Opacity;
}
/**
 * A box is a rectangle drawn behind a text.
 *
 * This interface was referenced by `Scene`'s JSON-Schema
 * via the `definition` "box".
 */
export interface Box {
  /**
   * The box is filled with this color, and it is not filled by default.
   */
  fill?: Color;
  /**
   * The box is outlined in this color, and it is not outlined by default.
   */
  edge?: Color;
  /**
   * The width of the outline is given in CSS pixels, and it is 1 by default.
   */
  edge_width?: number;
  /**
   * The box surrounds the text by this many CSS pixels, and by 4 by default.
   */
  pad?: number;
  /**
   * The radius of the corners is given in CSS pixels, and it is 0 by default.
   */
  radius?: number;
  /**
   * The opacity of the box is in [0, 1], and it is 1 by default.
   */
  opacity?: number;
}
