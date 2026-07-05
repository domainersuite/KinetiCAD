# image-to-cad

Generate **parametric, editable KinetiCAD models** from photos and/or text
descriptions using a vision LLM (Claude). Unlike photo-to-mesh tools that
output frozen triangle soup, this emits KinetiCAD's native JSON — sketches,
feature history, materials, and kinematic mates — so the result is real CAD
you can edit, simulate, and re-export.

## How it works

```
photos + description
   → Claude (vision) with PROMPT.md (the KinetiCAD schema spec + windmill example)
   → model JSON
   → validate.mjs (structural + referential + mate-anchor checks)
   → on errors: feed them back to the model and retry (up to 3 attempts)
   → out/model.json  → load via KinetiCAD's toolbar Load button
```

## Usage

```sh
cd tools/image-to-cad
npm install                       # only needed for generation mode

export ANTHROPIC_API_KEY=sk-ant-...

# From photos (front + side views work best) with a reference measurement:
node generate.mjs -i front.jpg -i side.jpg \
  --describe "desk fan; base is 150mm wide" -o out/fan.json

# Text-only works too:
node generate.mjs --describe "a seesaw: 400mm plank on an 80mm pedestal, \
  steel weight cube on one end" -o out/seesaw.json

# Validate/wrap a model produced elsewhere (no API key needed):
node generate.mjs --from-json draft.json -o out/model.json
node validate.mjs out/model.json
```

Then in KinetiCAD: **Load** → pick the file. The model arrives with full
feature history — every sketch and extrude is editable.

## What it can model

Anything expressible in KinetiCAD's current feature set: prismatic parts
(extrudes of circles/rectangles/polygons), turned parts (revolves), assemblies
with revolute/prismatic/spherical/fixed mates, optional motors. Good targets:
mechanisms, brackets, fixtures, furniture-like objects. Poor targets: organic
or sculpted surfaces (use photogrammetry → mesh for those).

## Verified

- `validate.mjs` passes the windmill physics-canary seed with 0 errors.
- A text-described seesaw (3 parts, revolute pivot + fixed weight bond)
  generated through this pipeline loads, regenerates through the OCCT kernel,
  and tips under gravity in the simulator as designed.

## Notes

- Default model: `claude-opus-4-8` (override with `IMAGE_TO_CAD_MODEL`).
- The validator's mate-anchor arithmetic check (world-point agreement between
  `pivotA`/`pivotB`) catches the most common generation error class.
- This package is intentionally **not** part of the pnpm workspace — it's a
  standalone tool with its own `npm install`, so it doesn't touch the app's
  lockfile.
