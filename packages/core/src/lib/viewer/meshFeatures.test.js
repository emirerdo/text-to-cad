import assert from "node:assert/strict";
import test from "node:test";
import { buildMeshFeatures, chainShape, meshFeatureSteps, nearestFeatureEdge } from "./meshFeatures.js";

// Every fixture is an indexed triangle soup whose true surfaces are known by construction.
const mesh = () => ({ positions: [], index: [] });
const vertex = (m, x, y, z) => { m.positions.push(x, y, z); return m.positions.length / 3 - 1; };
const triangle = (m, a, b, c) => m.index.push(a, b, c);
const quad = (m, a, b, c, d) => { triangle(m, a, b, c); triangle(m, a, c, d); };
const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not ${expected} +- ${tolerance}`);

function box(m, [x0, y0, z0], [x1, y1, z1]) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].map(p => vertex(m, ...p));
  quad(m, v[3], v[2], v[1], v[0]); quad(m, v[4], v[5], v[6], v[7]);
  quad(m, v[0], v[1], v[5], v[4]); quad(m, v[1], v[2], v[6], v[5]);
  quad(m, v[2], v[3], v[7], v[6]); quad(m, v[3], v[0], v[4], v[7]);
  return m;
}

/** A bar along +x whose section's two top corners are rounded R, tangent to the top and the sides. */
function filletedBar({ length = 100, width = 18, height = 14, radius = 2, steps = 8 }) {
  const m = mesh();
  const section = [[0, 0], [width, 0]];
  for (let i = 0; i <= steps; i += 1) { const a = (Math.PI / 2) * (i / steps); section.push([width - radius + radius * Math.cos(a), height - radius + radius * Math.sin(a)]); }
  for (let i = 0; i <= steps; i += 1) { const a = Math.PI / 2 + (Math.PI / 2) * (i / steps); section.push([radius + radius * Math.cos(a), height - radius + radius * Math.sin(a)]); }
  const near = section.map(([y, z]) => vertex(m, 0, y, z));
  const far = section.map(([y, z]) => vertex(m, length, y, z));
  section.forEach((_, i) => { const j = (i + 1) % section.length; quad(m, near[j], far[j], far[i], near[i]); });
  for (let i = 1; i < section.length - 1; i += 1) { triangle(m, near[0], near[i], near[i + 1]); triangle(m, far[0], far[i + 1], far[i]); }
  return m;
}

function cylinder({ radius = 5, height = 20, sides = 48 }) {
  const m = mesh();
  const bottom = [], top = [];
  for (let i = 0; i < sides; i += 1) {
    const a = (2 * Math.PI * i) / sides;
    bottom.push(vertex(m, radius * Math.cos(a), radius * Math.sin(a), 0));
    top.push(vertex(m, radius * Math.cos(a), radius * Math.sin(a), height));
  }
  const c0 = vertex(m, 0, 0, 0), c1 = vertex(m, 0, 0, height);
  for (let i = 0; i < sides; i += 1) {
    const j = (i + 1) % sides;
    quad(m, bottom[i], bottom[j], top[j], top[i]);
    triangle(m, c0, bottom[j], bottom[i]);
    triangle(m, c1, top[i], top[j]);
  }
  return m;
}

/** A plate: plan corners rounded `plan`, its top edge rolled `roll`, the corners of that roll a torus. */
function rolledPlate({ w = 106, d = 40, h = 14, plan = 8, roll = 2, arc = 12, steps = 6 }) {
  const m = mesh();
  const outline = [];
  const corner = (cx, cy, from) => { for (let i = 0; i <= arc; i += 1) { const a = from + (Math.PI / 2) * (i / arc); outline.push([cx, cy, a]); } };
  corner(w - plan, plan, -Math.PI / 2); corner(w - plan, d - plan, 0); corner(plan, d - plan, Math.PI / 2); corner(plan, plan, Math.PI);
  const profile = [[0, 0], [0, h - roll]];
  for (let i = 1; i <= steps; i += 1) { const a = (Math.PI / 2) * (i / steps); profile.push([-roll + roll * Math.cos(a), h - roll + roll * Math.sin(a)]); }
  const rings = profile.map(([inset, z]) => outline.map(([cx, cy, a]) => vertex(m, cx + (plan + inset) * Math.cos(a), cy + (plan + inset) * Math.sin(a), z)));
  for (let r = 0; r + 1 < rings.length; r += 1) outline.forEach((_, i) => { const j = (i + 1) % outline.length; quad(m, rings[r][i], rings[r][j], rings[r + 1][j], rings[r + 1][i]); });
  const last = rings[rings.length - 1], first = rings[0];
  for (let i = 1; i + 1 < outline.length; i += 1) { triangle(m, last[0], last[i], last[i + 1]); triangle(m, first[0], first[i + 1], first[i]); }
  return m;
}

const planes = features => features.faces.filter(face => face.surface === "plane");
const cylinders = features => features.faces.filter(face => face.surface === "cylinder");
const axisOf = vector => vector.map(c => Math.round(c * 1000) / 1000 + 0);
const faceWith = (features, normal) => features.faces.find(face => face.surface === "plane" && face.normal.every((c, i) => Math.abs(c - normal[i]) < 1e-6));
const totalArea = features => features.faces.reduce((sum, face) => sum + face.area, 0);

test("a box is six planes joined by twelve straight edges", () => {
  const f = buildMeshFeatures(box(mesh(), [0, 0, 0], [10, 20, 30]).positions, box(mesh(), [0, 0, 0], [10, 20, 30]).index);
  assert.equal(f.faces.length, 6);
  assert.equal(planes(f).length, 6);
  const top = faceWith(f, [0, 0, 1]);
  close(top.area, 200, 1e-9, "top area");
  assert.deepEqual(axisOf(top.normal), [0, 0, 1]);
  close(top.offset, 30, 1e-9, "top plane");
  assert.deepEqual(top.bbox, { min: [0, 0, 30], max: [10, 20, 30] });
  assert.equal(f.edges.length, 12);
  assert.ok(f.edges.every(edge => edge.shape === "line" && Math.abs(edge.angle - 90) < 1e-6 && !edge.closed));
  assert.deepEqual(f.edges.map(edge => Math.round(edge.length)).sort((a, b) => a - b), [10, 10, 10, 10, 20, 20, 20, 20, 30, 30, 30, 30]);
});

test("a rolled edge is its own cylinder and does not swallow the tangent plane beside it", () => {
  const bar = filletedBar({ radius: 2, steps: 8 });
  const f = buildMeshFeatures(bar.positions, bar.index);
  assert.equal(cylinders(f).length, 2);
  assert.equal(planes(f).length, 6, "bottom, two sides, top, two ends");
  for (const face of cylinders(f)) {
    close(face.radius, 2, 0.01, "radius");
    assert.deepEqual(axisOf(face.axis).map(Math.abs), [1, 0, 0]);
    assert.equal(face.convex, true);
    close(face.sweep, 90, 0.5, "sweep");
    close(face.area, 100 * 2 * (Math.PI / 2), 1.5, "area");
  }
  close(faceWith(f, [0, 0, 1]).area, 100 * (18 - 4), 1e-6, "the top keeps only its flat");
});

test("a round bar is one cylinder closed by two planes, ringed by two circles", () => {
  const c = cylinder({ radius: 5, height: 20, sides: 48 });
  const f = buildMeshFeatures(c.positions, c.index);
  assert.equal(f.faces.length, 3);
  assert.equal(cylinders(f).length, 1);
  close(cylinders(f)[0].radius, 5, 0.01, "radius");
  close(cylinders(f)[0].sweep, 360, 0.01, "sweep");
  const circles = f.edges.filter(edge => edge.shape === "circle");
  assert.equal(circles.length, 2);
  for (const edge of circles) { assert.equal(edge.closed, true); close(edge.radius, 5, 0.01, "edge radius"); close(edge.length, 2 * Math.PI * 5, 0.05, "edge length"); }
});

test("a rolled plate comes apart as a designer would name it", () => {
  const plate = rolledPlate({});
  const f = buildMeshFeatures(plate.positions, plate.index);
  // Top and bottom; four straight walls; four R8 wall corners; four straight R2 rolls; four roll corners.
  assert.equal(planes(f).length, 6, planes(f).map(face => face.area.toFixed(1)).join());
  const radii = cylinders(f).map(face => Math.round(face.radius)).sort((a, b) => a - b);
  assert.deepEqual(radii, [2, 2, 2, 2, 8, 8, 8, 8]);
  assert.equal(f.faces.filter(face => face.surface === "curved").length, 4);
});

test("the faces partition the surface: every triangle has one and their areas add up", () => {
  const plate = rolledPlate({});
  const f = buildMeshFeatures(plate.positions, plate.index);
  let surface = 0;
  for (let t = 0; t < plate.index.length / 3; t += 1) {
    const [a, b, c] = [0, 1, 2].map(i => plate.index[3 * t + i]).map(v => [plate.positions[3 * v], plate.positions[3 * v + 1], plate.positions[3 * v + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    surface += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    assert.ok(f.faceOfTriangle(t) >= 0, `triangle ${t} has no face`);
  }
  close(totalArea(f), surface, 1e-6, "area");
  assert.equal(f.faces.reduce((sum, face) => sum + f.trianglesOfFace(face.id).length, 0), plate.index.length / 3);
});

test("two separate bodies in one file are two shells, and each face names its own", () => {
  const m = box(box(mesh(), [0, 0, 0], [10, 10, 10]), [20, 0, 0], [30, 10, 10]);
  const f = buildMeshFeatures(m.positions, m.index);
  assert.equal(f.shells.length, 2);
  assert.deepEqual(f.shells.map(shell => shell.bbox.min[0]).sort((a, b) => a - b), [0, 20]);
  assert.deepEqual([...new Set(f.faces.map(face => face.shell))].sort(), [0, 1]);
});

test("an unindexed soup welds to the same features as its indexed form", () => {
  const b = box(mesh(), [0, 0, 0], [10, 20, 30]);
  const soup = b.index.flatMap(v => [b.positions[3 * v], b.positions[3 * v + 1], b.positions[3 * v + 2]]);
  const f = buildMeshFeatures(soup, null);
  assert.equal(f.faces.length, 6);
  assert.equal(f.edges.length, 12);
});

test("degenerate triangles and open borders neither break nor invent faces", () => {
  const m = mesh();
  const [a, b, c, d] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]].map(p => vertex(m, ...p));
  quad(m, a, b, c, d);
  triangle(m, a, a, b);
  const f = buildMeshFeatures(m.positions, m.index);
  assert.equal(planes(f).length, 1);
  close(planes(f)[0].area, 100, 1e-9, "area");
  assert.equal(f.edges.length, 1, "the open border is one closed chain");
  assert.equal(f.edges[0].faces[1], -1);
  assert.equal(f.edges[0].closed, true);
});

test("a triangle-free mesh is empty, not an error", () => {
  const f = buildMeshFeatures([], []);
  assert.equal(f.faces.length, 0);
  assert.equal(f.edges.length, 0);
});

test("the build is sliced: the generator yields and ends with the same answer", () => {
  const big = cylinder({ radius: 5, height: 20, sides: 12000 });
  const steps = meshFeatureSteps(big.positions, big.index);
  let yields = 0, step = steps.next();
  while (!step.done) { yields += 1; step = steps.next(); }
  assert.ok(yields > 3, `only ${yields} yields`);
  assert.equal(step.value.faces.length, 3);
});

test("the nearest edge is the one of the clicked face within the tolerance, or none", () => {
  const b = box(mesh(), [0, 0, 0], [10, 20, 30]);
  const f = buildMeshFeatures(b.positions, b.index);
  const top = faceWith(f, [0, 0, 1]);
  const near = nearestFeatureEdge(f, top.id, [5, 0.2, 30], 0.5);
  assert.ok(near);
  assert.equal(Math.round(near.edge.length), 10);
  close(near.distance, 0.2, 1e-9, "distance");
  assert.equal(nearestFeatureEdge(f, top.id, [5, 10, 30], 0.5), null);
});

test("an arc is an arc only where its points lie on one: a long run with bent ends is not a huge radius", () => {
  const arc = [];
  for (let i = 0; i <= 12; i += 1) { const a = (Math.PI / 2) * (i / 12); arc.push(8 * Math.cos(a), 8 * Math.sin(a), 0); }
  const told = chainShape(Float64Array.from(arc), false, 0.002);
  assert.equal(told.shape, "arc");
  close(told.radius, 8, 1e-6, "radius");
  close(told.sweep, 90, 1e-6, "sweep");
  const bentEnds = [-0.6, 0.6, 0, 0, 0, 0, 30, 0, 0, 60, 0, 0, 91, 0, 0, 91.6, 0.6, 0];
  assert.equal(chainShape(Float64Array.from(bentEnds), false, 0.002).shape, "curve");
});
