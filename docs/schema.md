# Scene schema

This page shows the JSON Schema of `scene.tys`, the scene document, at version {{ scene_format }} of the scene format.
A JSON Schema is a JSON document that specifies which keys, types, and values another JSON document may hold, and this one follows draft 2020-12 of the standard.
The schema thus fixes the structure of a scene.
The [named rules](spec.md) cover what a schema cannot express, which falls into three kinds.

- A cross-reference ties one part of a scene to another, e.g. the `parent` of a frame must refer to a declared frame.
- A rule can depend on the data, e.g. a clock channel must be strictly monotone along every trajectory (rule `monotone-clock-channel`).
- A rule may have to hold for every value the inputs can take.
  An example is rule `transform-channels`, under which a trajectory set must carry every channel that the transforms on the way to the display frame read, whatever display frame a choice selects.

The tests of pytycho validate every scene they write against the schema, i.e. they check that the scene has the structure that the schema describes.
A writer never emits a key that is not in the schema.

The raw file, i.e. the JSON itself rather than this rendered page, is published at {{ schema_link }}, with the raw spec beside it at {{ spec_link }}.
Both lie under the path that the `$id` of the schema gives, i.e. the URL that identifies the schema.
The source of the schema is [`spec/scene.schema.json`](https://github.com/beeson-group/tycho/blob/main/spec/scene.schema.json).

```{literalinclude} ../spec/scene.schema.json
:language: json
```
