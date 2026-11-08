import assert from "node:assert/strict";
import test from "node:test";
import { buildMeshFeatures } from "@text-to-cad/core/lib/viewer/meshFeatures.js";
import { featureKey, featureLabel, featureRecord, formatFeatureRecord, resolveFeature, viewWords } from "./featureRecord.js";

function box([x0, y0, z0], [x1, y1, z1]) {
  const positions = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].flat();
  const quads = [[3, 2, 1, 0], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  return { positions, index: quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]) };
}

const block = box([0, 0, 0], [106, 92, 14]);
const features = buildMeshFeatures(block.positions, block.index);
const triangleOn = normal => {
  const face = features.faces.find(candidate => candidate.normal.every((c, i) => Math.abs(c - normal[i]) < 1e-9));
  return features.trianglesOfFace(face.id)[0];
};
const TOP = triangleOn([0, 0, 1]);
const part = { name: "mini", path: "/repo/mini.stl", bbox: { min: [0, 0, 0], max: [106, 92, 14] }, shells: 1 };
const frame = { unitsToMm: 1, toAssembly: ([x, y, z]) => [x, -z, y], directionToAssembly: ([x, y, z]) => [x, -z, y] };

test("All picks the face under the pointer, away from any edge", () => {
  assert.deepEqual(resolveFeature(features, { triangle: TOP, point: [53, 46, 14], mode: "all", tolerance: 0.5 }), { kind: "face", faceId: features.faceOfTriangle(TOP), point: [53, 46, 14] });
});

test("All picks the edge when the pointer is within the tolerance of one", () => {
  const resolved = resolveFeature(features, { triangle: TOP, point: [53, 0.2, 14], mode: "all", tolerance: 0.5 });
  assert.equal(resolved.kind, "edge");
  assert.equal(Math.round(features.edges[resolved.edgeId].length), 106);
});

test("Faces never turns into an edge, and Points is the point itself", () => {
  assert.equal(resolveFeature(features, { triangle: TOP, point: [53, 0.2, 14], mode: "faces", tolerance: 0.5 }).kind, "face");
  assert.equal(resolveFeature(features, { triangle: TOP, point: [53, 0.2, 14], mode: "points", tolerance: 0.5 }).kind, "point");
});

test("Edges reaches further than All, and over open surface finds nothing", () => {
  assert.equal(resolveFeature(features, { triangle: TOP, point: [53, 1.2, 14], mode: "edges", tolerance: 0.5 }).kind, "edge");
  assert.equal(resolveFeature(features, { triangle: TOP, point: [53, 46, 14], mode: "edges", tolerance: 0.5 }), null);
});

test("two hovers over the same feature are the same; points differ by where", () => {
  const a = resolveFeature(features, { triangle: TOP, point: [50, 40, 14], mode: "faces", tolerance: 0.5 });
  const b = resolveFeature(features, { triangle: TOP, point: [60, 30, 14], mode: "faces", tolerance: 0.5 });
  assert.equal(featureKey(a), featureKey(b));
  const p = resolveFeature(features, { triangle: TOP, point: [50, 40, 14], mode: "points", tolerance: 0.5 });
  const q = resolveFeature(features, { triangle: TOP, point: [60, 30, 14], mode: "points", tolerance: 0.5 });
  assert.notEqual(featureKey(p), featureKey(q));
});

test("a face is told by what it is, where it is and what is behind it, in the part's millimetres", () => {
  const resolved = resolveFeature(features, { triangle: TOP, point: [53.1, 9.02, 14], mode: "faces", tolerance: 0.5 });
  const record = featureRecord({ features, resolved, part, frame, view: "front-right, above", behind: 14, ahead: null });
  assert.equal(formatFeatureRecord(record, 1), [
    "1 face · mini · /repo/mini.stl",
    "  plane, normal +Z (assembly -Y), z = 14.00, x 0.00..106.00, y 0.00..92.00, area 9752.00 mm²",
    "  clicked (53.10, 9.02, 14.00), seen from front-right, above; 14.00 of material behind it along -Z; part 106.00 x 92.00 x 14.00",
  ].join("\n"));
  assert.equal(featureLabel(record, 1), "1 face · mini · plane z = 14.00");
});

test("a part modelled in metres is still told in millimetres", () => {
  const metres = box([0, 0, 0], [0.106, 0.092, 0.014]);
  const f = buildMeshFeatures(metres.positions, metres.index);
  const t = f.trianglesOfFace(f.faces.find(face => Math.abs(face.normal[2] - 1) < 1e-9).id)[0];
  const resolved = resolveFeature(f, { triangle: t, point: [0.05, 0.04, 0.014], mode: "faces", tolerance: 0.0005 });
  const record = featureRecord({ features: f, resolved, part: { ...part, bbox: { min: [0, 0, 0], max: [0.106, 0.092, 0.014] } }, frame: { ...frame, unitsToMm: 1000 }, view: "above" });
  assert.match(formatFeatureRecord(record, 2), /z = 14\.00, x 0\.00\.\.106\.00/);
  assert.match(formatFeatureRecord(record, 2), /area 9752\.00 mm²/);
  assert.match(formatFeatureRecord(record, 2), /clicked \(50\.00, 40\.00, 14\.00\)/);
});

test("an edge is told by its shape, length and ends", () => {
  const resolved = resolveFeature(features, { triangle: TOP, point: [53, 0.2, 14], mode: "edges", tolerance: 0.5 });
  const text = formatFeatureRecord(featureRecord({ features, resolved, part, frame, view: "front" }), 3);
  assert.match(text, /^3 edge · mini · \/repo\/mini\.stl\n/);
  assert.match(text, /line, 106\.00 long, from \(.+\) to \(.+\), sharp 90°/);
});

test("an edge beside a rolled surface is tangent, whatever angle its facets happen to make", () => {
  const record = { kind: "edge", view: "front", behind: null, ahead: null, clicked: [0, 0, 0], part: { ...part, unitsToMm: 1 }, face: {},
    edge: { shape: "line", length: 100, closed: false, angle: 5.6, start: [0, 0, 0], end: [100, 0, 0], between: ["plane y = 18.00", "cylinder R2.00"] } };
  assert.match(formatFeatureRecord(record, 1), /, tangent, joins plane y = 18\.00 and cylinder R2\.00/);
  record.edge.between = ["plane y = 18.00", "plane z = 14.00"];
  assert.match(formatFeatureRecord(record, 1), /, sharp 6°, joins/);
});

test("a body among several is named, so a letter of a word can be told apart", () => {
  const resolved = resolveFeature(features, { triangle: TOP, point: [53, 46, 14], mode: "faces", tolerance: 0.5 });
  const text = formatFeatureRecord(featureRecord({ features: { ...features, shells: [features.shells[0], { id: 1, faces: 6, area: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] } }] }, resolved, part: { ...part, shells: 2 }, frame, view: "front" }), 1);
  assert.match(text, /body 1 of 2, x 0\.00\.\.106\.00, y 0\.00\.\.92\.00, z 0\.00\.\.14\.00/);
});

test("what stands in front of a face is named with its distance", () => {
  const resolved = resolveFeature(features, { triangle: TOP, point: [53, 46, 14], mode: "faces", tolerance: 0.5 });
  const text = formatFeatureRecord(featureRecord({ features, resolved, part, frame, view: "front", ahead: { name: "plate", distance: 0.15 } }), 1);
  assert.match(text, /plate 0\.15 ahead along \+Z/);
});

test("a whole part needs no pointer", () => {
  const text = formatFeatureRecord({ kind: "part", part: { ...part, unitsToMm: 1 } }, 4);
  assert.equal(text, "4 part · mini · /repo/mini.stl\n  106.00 x 92.00 x 14.00, x 0.00..106.00, y 0.00..92.00, z 0.00..14.00");
});

test("a view is named in the words a person uses, front being -Y", () => {
  assert.equal(viewWords([0, -1, 0]), "front");
  assert.equal(viewWords([0.7, -0.7, 0]), "front-right");
  assert.equal(viewWords([-0.5, -0.5, 0.7]), "front-left, above");
  assert.equal(viewWords([0, 0.2, -0.98]), "below");
});
