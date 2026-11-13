# Glossary

The words used in TyCHO in a narrower sense than in everyday English, and the words coined for TyCHO, are defined here, each with one meaning across pytycho, the runtime, the schema, and the docs. An entry is added the moment a term is settled, hence the file grows as terms are settled, and the names in the code are chosen after it. Before a word is coined, the word that astrodynamics, NumPy, matplotlib, Plotly, or everyday English already has is used instead.

## Convention

A rule of TyCHO that is followed by default and may be argued with, as opposed to a hard invariant.

## Frame

A reference frame, i.e. the coordinate system in which positions are expressed, such as the rotating frame of the restricted three-body problem.

Avoid "frame" and "animation frame" for an instant of the animation, which is a frame index.

## Frame index

The integer number of an instant of the animation. Two indices that differ by a whole loop are the same instant.

Avoid "animation frame", "step", and "tick".

## Hard invariant

A rule of TyCHO that is never traded away for another goal, and that an agent does not break without asking first. The hard invariants are listed at the top of `AGENTS.md`.

## Page

The one HTML file that a user shares, in which a scene and the runtime are embedded, and which works offline.

Avoid "visualization", "demo", "deliverable", and "bundle".

## Runtime

The JavaScript that draws a scene in the browser, which is embedded in every page and published on npm as `@beeson-group/tycho`.

## Scene

What is shown on a page, as described by the scene document `scene.tys` and the data container `data.tyd`.

## Viewer

The `<tycho-viewer>` element, in which a scene is shown on a page.
