import { nearestFeatureEdge } from "@text-to-cad/core/lib/viewer/meshFeatures.js";

// What a pick on a triangle mesh means, and how it is told to an agent: pure, so what the agent
// reads is tested number by number. The numbers are in millimetres and in the part's own frame,
// the one its mesh file (and whatever built it) speaks; the assembly's frame is said beside it where the
// part is placed, since "the top" is the top as a person sees it.

// Edges mode is for edges alone, so its reach is wider than All's, where the face also wants the pointer.
const EDGES_REACH = 3;

/** The feature a pointer is on under a Select mode, or null; `tolerance` and `point` in the mesh's units. */
export function resolveFeature(features, { triangle, point, mode, tolerance }) {
  const faceId = features.faceOfTriangle(triangle);
  if (faceId < 0) return null;
  if (mode === "points") return { kind: "point", faceId, point };
  if (mode === "faces") return { kind: "face", faceId, point };
  const near = nearestFeatureEdge(features, faceId, point, mode === "edges" ? tolerance * EDGES_REACH : tolerance);
  if (near) return { kind: "edge", faceId, edgeId: near.edge.id, point };
  return mode === "edges" ? null : { kind: "face", faceId, point };
}

/** Two resolved features are the same thing to a person when their keys match. */
export function featureKey(resolved) {
  if (!resolved) return "";
  if (resolved.kind === "edge") return `edge:${resolved.edgeId}`;
  if (resolved.kind === "face") return `face:${resolved.faceId}`;
  return `point:${resolved.point.join(",")}`;
}

const scaled = (vector, factor) => vector.map(c => c * factor);
const scaledBox = (box, factor) => ({ min: scaled(box.min, factor), max: scaled(box.max, factor) });

/**
 * A resolved feature in millimetres, with what is around it.
 *
 * @param {object} options
 * @param {{ unitsToMm: number, toAssembly?: (point: number[]) => number[], directionToAssembly?: (vector: number[]) => number[] }} options.frame
 * @param {string} options.view  Where it was seen from (`viewWords`).
 * @param {number | null} [options.behind]  Millimetres of material behind the point.
 * @param {{ name: string, distance: number } | null} [options.ahead]  What stands in front of it.
 */
export function featureRecord({ features, resolved, part, frame, view, behind = null, ahead = null }) {
  const u = frame.unitsToMm;
  const face = features.faces[resolved.faceId];
  const record = {
    kind: resolved.kind, view, behind, ahead,
    part: { ...part, unitsToMm: u },
    clicked: scaled(resolved.point, u),
    face: {
      surface: face.surface, normal: face.normal, normalAssembly: frame.directionToAssembly?.(face.normal) ?? null,
      offset: face.offset === undefined ? null : face.offset * u,
      bbox: scaledBox(face.bbox, u), area: face.area * u * u, centroid: scaled(face.centroid, u),
      ...(face.surface === "cylinder" ? { radius: face.radius * u, axis: face.axis, center: scaled(face.center, u), convex: face.convex, sweep: face.sweep } : {}),
    },
  };
  if (resolved.kind === "edge") {
    const edge = features.edges[resolved.edgeId];
    record.edge = {
      shape: edge.shape, length: edge.length * u, closed: edge.closed, angle: edge.angle,
      start: scaled(edge.start, u), end: scaled(edge.end, u),
      ...(edge.radius === undefined ? {} : { radius: edge.radius * u, center: scaled(edge.center, u), axis: edge.axis }),
      ...(edge.sweep === undefined ? {} : { sweep: edge.sweep }),
      between: edge.faces.filter(id => id >= 0).map(id => faceShort(faceInMm(features.faces[id], u))),
    };
  }
  if (features.shells.length > 1) {
    const index = features.shells.findIndex(shell => shell.id === face.shell);
    record.body = { index: index + 1, count: features.shells.length, bbox: scaledBox(features.shells[index].bbox, u) };
  }
  return record;
}

const faceInMm = (face, u) => ({ surface: face.surface, normal: face.normal, offset: face.offset === undefined ? null : face.offset * u, radius: face.radius === undefined ? undefined : face.radius * u, centroid: scaled(face.centroid, u) });

const number = value => (Math.abs(value) < 0.005 ? 0 : value).toFixed(2);
const tuple = vector => `(${vector.map(number).join(", ")})`;
const AXES = ["X", "Y", "Z"];

/** A direction by its axis where it is one (+Z), else by its components. */
function direction(vector, sign = 1) {
  const axis = vector.findIndex(c => Math.abs(Math.abs(c) - 1) < 1e-4);
  return axis < 0 ? tuple(vector.map(c => c * sign)) : `${vector[axis] * sign > 0 ? "+" : "-"}${AXES[axis]}`;
}

function extents(box) {
  return AXES.flatMap((name, i) => (box.max[i] - box.min[i] < 0.005 ? [] : [`${name.toLowerCase()} ${number(box.min[i])}..${number(box.max[i])}`])).join(", ");
}

/** Where a plane stands: `z = 14.00` on an axis, a point it passes through otherwise. */
function planeAt(face) {
  const axis = face.normal.findIndex(c => Math.abs(Math.abs(c) - 1) < 1e-4);
  return axis < 0 ? `through ${tuple(face.centroid)}` : `${AXES[axis].toLowerCase()} = ${number(face.offset * face.normal[axis])}`;
}

function faceShort(face) {
  if (face.surface === "plane") return `plane ${planeAt(face)}`;
  if (face.surface === "cylinder") return `cylinder R${number(face.radius)}`;
  return "curved surface";
}

function faceLine(face) {
  const where = extents(face.bbox);
  const area = `area ${number(face.area)} mm²`;
  if (face.surface === "plane") {
    const assembly = face.normalAssembly && direction(face.normalAssembly) !== direction(face.normal) ? ` (assembly ${direction(face.normalAssembly)})` : "";
    return `plane, normal ${direction(face.normal)}${assembly}, ${planeAt(face)}, ${where}, ${area}`;
  }
  if (face.surface === "cylinder") {
    const round = face.sweep >= 359.5 ? "" : `, ${face.sweep.toFixed(0)}° of arc`;
    return `cylinder R${number(face.radius)} ${face.convex ? "convex" : "concave"}, axis ${direction(face.axis)}${round}, ${where}, ${area}`;
  }
  return `curved surface, ${where}, ${area}`;
}

function edgeShort(edge) {
  if (edge.shape === "line") return `line ${number(edge.length)}`;
  if (edge.shape === "arc" || edge.shape === "circle") return `${edge.shape} R${number(edge.radius)}`;
  return `curve ${number(edge.length)}`;
}

function edgeLine(edge) {
  // Beside a curved face the angle measured is the facets' own, up to half their step: a join that smooth is tangent.
  const tangentBelow = edge.between.some(name => !name.startsWith("plane")) ? 20 : 1;
  const meeting = edge.angle === null ? "open border" : edge.angle < tangentBelow ? "tangent" : `sharp ${edge.angle.toFixed(0)}°`;
  const ends = edge.closed ? "" : `, from ${tuple(edge.start)} to ${tuple(edge.end)}`;
  const circle = edge.radius === undefined ? "" : `, center ${tuple(edge.center)}, axis ${direction(edge.axis)}`;
  const name = edge.shape === "arc" ? `arc R${number(edge.radius)}, ${edge.sweep.toFixed(0)}°` : edge.shape === "circle" ? `circle R${number(edge.radius)}` : edge.shape;
  const between = edge.between.length === 2 ? `, joins ${edge.between[0]} and ${edge.between[1]}` : "";
  return `${name}, ${number(edge.length)} long${ends}${circle}, ${meeting}${between}`;
}

const partSize = part => {
  const u = part.unitsToMm ?? 1;
  return part.bbox.max.map((c, i) => number((c - part.bbox.min[i]) * u)).join(" x ");
};

/** A record as the agent reads it: a line naming it, a line saying what it is, a line saying where. */
export function formatFeatureRecord(record, ordinal) {
  const heading = `${ordinal} ${record.kind} · ${record.part.name} · ${record.part.path}`;
  if (record.kind === "part") return `${heading}\n  ${partSize(record.part)}, ${extents(scaledBox(record.part.bbox, record.part.unitsToMm ?? 1))}`;
  const what = record.kind === "edge" ? edgeLine(record.edge) : record.kind === "point" ? `on ${faceShort(record.face)}` : faceLine(record.face);
  const along = sign => (record.face.surface === "plane" ? ` along ${direction(record.face.normal, sign)}` : "");
  const where = [`clicked ${tuple(record.clicked)}, seen from ${record.view}`];
  if (record.behind !== null && record.kind !== "edge") where.push(`${number(record.behind)} of material behind it${along(-1)}`);
  if (record.ahead && record.kind !== "edge") where.push(`${record.ahead.name} ${number(record.ahead.distance)} ahead${along(1)}`);
  where.push(`part ${partSize(record.part)}`);
  if (record.body) where.push(`body ${record.body.index} of ${record.body.count}, ${extents(record.body.bbox)}`);
  return `${heading}\n  ${what}\n  ${where.join("; ")}`;
}

/** The short form a person reads in the Quick Edit's chip. */
export function featureLabel(record, ordinal) {
  const what = record.kind === "part" ? partSize(record.part) : record.kind === "edge" ? edgeShort(record.edge) : faceShort(record.face);
  return `${ordinal} ${record.kind} · ${record.part.name} · ${what}`;
}

/** Where a camera looks from, as a person says it: `direction` runs from the model to the camera, in the assembly's frame (front is -Y, up is +Z). */
export function viewWords(direction) {
  const [x, y, z] = direction;
  const around = [y < -0.35 ? "front" : y > 0.35 ? "back" : "", x > 0.35 ? "right" : x < -0.35 ? "left" : ""].filter(Boolean).join("-");
  const height = z > 0.35 ? "above" : z < -0.35 ? "below" : "";
  return [around, height].filter(Boolean).join(", ") || "front";
}
