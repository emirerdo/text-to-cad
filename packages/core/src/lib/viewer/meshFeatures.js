// What a triangle mesh is made of, as a person would name it: faces (a plane, a cylinder and its
// radius, some other curved surface), the edges where two faces meet, and the separate bodies.
// An STL carries none of this, so it is read back off the triangles: a viewer that can only say
// "triangle 48213" cannot be told "this wall" or "that fillet".
//
// How a surface comes apart:
//   1. Coplanar triangles flood into patches, measured by distance to the seed's plane (a sliver's
//      own normal is noise).
//   2. A tessellated cylinder is a row of long thin patches. Two patches join only if they meet
//      smoothly, along one straight line parallel to both strips, and are about as wide: width alone
//      welds every fillet of a part into one network, and smoothness alone swallows the tangent plane.
//   3. Short runs of strips side by side, each with its own axis, are a torus cut up by its own
//      facets (a fillet turning a corner): they join each other, and stay apart from the long
//      cylinders. So do what is left of the small patches, by smoothness and width.
//
// The work is a generator that yields every few thousand steps: a 700 000 triangle sign plate
// must not stop the viewport. `buildMeshFeatures` runs it through at once.

const SLICE = 0x3fff;
const SMOOTH_COS = Math.cos((35 * Math.PI) / 180);
const PARALLEL_COS = Math.cos((0.5 * Math.PI) / 180);
const WIDTH_RATIO = 3;
const MIN_STRIPS = 3;
const MIN_PATCHES = 4;
const MAX_FIT_POINTS = 4096;

const EMPTY_LIST = new Int32Array(0);
const emptyFeatures = () => ({
  triangleCount: 0, faces: [], edges: [], shells: [],
  faceOfTriangle: () => -1, trianglesOfFace: () => EMPTY_LIST,
});

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = v => Math.hypot(v[0], v[1], v[2]);
const unit3 = v => { const n = norm3(v); return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0]; };

/** A plane's two axes, for a direction given as a unit vector. */
function planeBasis(normal) {
  const seed = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit3(cross3(normal, seed));
  return [u, cross3(normal, u)];
}

/** The circle through 2D points (x, y pairs), by the algebraic fit around their mean; null if they are a line. */
function fitCircle2D(points) {
  const n = points.length / 2;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i += 1) { mx += points[2 * i]; my += points[2 * i + 1]; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i += 1) {
    const u = points[2 * i] - mx, v = points[2 * i + 1] - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (!(Math.abs(det) > 1e-18 * Math.max(suu * svv, 1e-30))) return null;
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det, vc = (b2 * suu - b1 * suv) / det;
  const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  const cx = uc + mx, cy = vc + my;
  let residual = 0;
  for (let i = 0; i < n; i += 1) residual = Math.max(residual, Math.abs(Math.hypot(points[2 * i] - cx, points[2 * i + 1] - cy) - radius));
  return { cx, cy, radius, residual };
}

/** The angle a set of points covers around a centre, in degrees: 360 when no gap stands out. */
function sweepOf(points, cx, cy) {
  const n = points.length / 2;
  const angles = new Float64Array(n);
  for (let i = 0; i < n; i += 1) angles[i] = Math.atan2(points[2 * i + 1] - cy, points[2 * i] - cx);
  angles.sort();
  const gaps = new Float64Array(n);
  let widest = 0;
  for (let i = 0; i < n; i += 1) {
    gaps[i] = i + 1 < n ? angles[i + 1] - angles[i] : angles[0] + 2 * Math.PI - angles[i];
    widest = Math.max(widest, gaps[i]);
  }
  const positive = [...gaps].filter(gap => gap > 1e-9).sort((a, b) => a - b);
  const typical = positive[positive.length >> 1] || 0;
  return widest <= typical * 1.5 ? 360 : ((2 * Math.PI - widest) * 180) / Math.PI;
}

function find(parent, a) {
  while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
  return a;
}
function union(parent, a, b) {
  const ra = find(parent, a), rb = find(parent, b);
  if (ra !== rb) parent[rb] = ra;
}

function pow2Above(value) {
  let size = 16;
  while (size < value) size *= 2;
  return size;
}

/** How far points may stray from a fitted circle: tessellation puts them on it, so a loose fit is no circle. */
const fitLimit = (radius, planeTolerance) => Math.max(planeTolerance * 5, Math.min(radius * 0.02, planeTolerance * 10));

/**
 * What a chain of points is: a line, an arc or circle with its radius, or a curve.
 *
 * @param {Float64Array} points  x, y, z per point; a closed chain repeats its first point last.
 * @param {boolean} closed
 * @param {number} planeTolerance  The mesh's own measure of "on the plane".
 */
export function chainShape(points, closed, planeTolerance) {
  const total = points.length / 3;
  const tolerance = planeTolerance * 5;
  const start = [points[0], points[1], points[2]], end = [points[points.length - 3], points[points.length - 2], points[points.length - 1]];
  if (!closed) {
    const chord = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const span = norm3(chord);
    let farthest = 0;
    if (span > 0) {
      const along = unit3(chord);
      for (let i = 1; i + 1 < total; i += 1) {
        const w = [points[3 * i] - start[0], points[3 * i + 1] - start[1], points[3 * i + 2] - start[2]];
        const t = dot3(w, along);
        farthest = Math.max(farthest, Math.hypot(w[0] - along[0] * t, w[1] - along[1] * t, w[2] - along[2] * t));
      }
    }
    if (span > 0 && farthest <= tolerance + span * 1e-5) return { shape: "line" };
  }
  const count = closed ? total - 1 : total;
  if (count < 4) return { shape: "curve" };
  // The chain's plane, by Newell's sum around it (the chord closes an arc).
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    nx += (points[3 * i + 1] - points[3 * j + 1]) * (points[3 * i + 2] + points[3 * j + 2]);
    ny += (points[3 * i + 2] - points[3 * j + 2]) * (points[3 * i] + points[3 * j]);
    nz += (points[3 * i] - points[3 * j]) * (points[3 * i + 1] + points[3 * j + 1]);
  }
  const normal = unit3([nx, ny, nz]);
  if (!norm3(normal)) return { shape: "curve" };
  const [u, v] = planeBasis(normal);
  const projected = [];
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const p = [points[3 * i], points[3 * i + 1], points[3 * i + 2]];
    projected.push(dot3(p, u), dot3(p, v));
    const h = dot3(p, normal);
    low = Math.min(low, h); high = Math.max(high, h);
  }
  const circle = fitCircle2D(projected);
  if (!circle || high - low > tolerance + circle.radius * 0.01 || circle.residual > fitLimit(circle.radius, planeTolerance)) return { shape: "curve" };
  const height = (high + low) / 2;
  const center = [0, 1, 2].map(i => u[i] * circle.cx + v[i] * circle.cy + normal[i] * height);
  return { shape: closed ? "circle" : "arc", radius: circle.radius, axis: normal, center, ...(closed ? {} : { sweep: sweepOf(projected, circle.cx, circle.cy) }) };
}

/**
 * The features of a mesh, a step at a time: drive the generator, its return value is the answer.
 *
 * @param {ArrayLike<number>} positions  x, y, z per vertex.
 * @param {ArrayLike<number> | null} [index]  Three per triangle; without one, each three vertices are a triangle.
 * @returns {Generator<void, MeshFeatures, void>}
 */
export function* meshFeatureSteps(positions, index = null) {
  const vertexCount = Math.floor(positions.length / 3);
  const triangleCount = index ? Math.floor(index.length / 3) : Math.floor(vertexCount / 3);
  if (!triangleCount) return emptyFeatures();

  // ---- scale: tolerances are the part's, whatever its unit -------------------------------------
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    if (!(i & SLICE)) yield;
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const weldStep = diagonal * 2e-7;
  const planeTolerance = diagonal * 2e-5;
  const areaFloor = diagonal * diagonal * 1e-14;

  // ---- weld ------------------------------------------------------------------------------------
  const welded = new Int32Array(vertexCount);
  const px = new Float64Array(vertexCount), py = new Float64Array(vertexCount), pz = new Float64Array(vertexCount);
  const qx = new Int32Array(vertexCount), qy = new Int32Array(vertexCount), qz = new Int32Array(vertexCount);
  const vertexMask = pow2Above(vertexCount * 2) - 1;
  const vertexSlots = new Int32Array(vertexMask + 1).fill(-1);
  let weldedCount = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    if (!(i & SLICE)) yield;
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const kx = Math.round((x - minX) / weldStep) | 0, ky = Math.round((y - minY) / weldStep) | 0, kz = Math.round((z - minZ) / weldStep) | 0;
    let slot = (Math.imul(kx, 73856093) ^ Math.imul(ky, 19349663) ^ Math.imul(kz, 83492791)) & vertexMask;
    for (;;) {
      const held = vertexSlots[slot];
      if (held < 0) {
        vertexSlots[slot] = weldedCount;
        px[weldedCount] = x; py[weldedCount] = y; pz[weldedCount] = z;
        qx[weldedCount] = kx; qy[weldedCount] = ky; qz[weldedCount] = kz;
        welded[i] = weldedCount;
        weldedCount += 1;
        break;
      }
      if (qx[held] === kx && qy[held] === ky && qz[held] === kz) { welded[i] = held; break; }
      slot = (slot + 1) & vertexMask;
    }
  }

  // ---- triangles -------------------------------------------------------------------------------
  const corners = new Int32Array(triangleCount * 3);
  const normals = new Float64Array(triangleCount * 3);
  const areas = new Float64Array(triangleCount);
  const collapsed = new Uint8Array(triangleCount);
  let largestArea = 0;
  for (let t = 0; t < triangleCount; t += 1) {
    if (!(t & SLICE)) yield;
    const a = welded[index ? index[3 * t] : 3 * t], b = welded[index ? index[3 * t + 1] : 3 * t + 1], c = welded[index ? index[3 * t + 2] : 3 * t + 2];
    corners[3 * t] = a; corners[3 * t + 1] = b; corners[3 * t + 2] = c;
    if (a === b || b === c || a === c) { collapsed[t] = 1; continue; }
    const ux = px[b] - px[a], uy = py[b] - py[a], uz = pz[b] - pz[a];
    const vx = px[c] - px[a], vy = py[c] - py[a], vz = pz[c] - pz[a];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const doubled = Math.sqrt(nx * nx + ny * ny + nz * nz);
    areas[t] = doubled / 2;
    if (areas[t] > largestArea) largestArea = areas[t];
    if (areas[t] > areaFloor) { normals[3 * t] = nx / doubled; normals[3 * t + 1] = ny / doubled; normals[3 * t + 2] = nz / doubled; }
  }

  // ---- who meets whom: each half-edge's opposite, -1 at a border or a non-manifold edge --------
  const opposite = new Int32Array(triangleCount * 3).fill(-1);
  const edgeMask = pow2Above(triangleCount * 4) - 1;
  const edgeU = new Int32Array(edgeMask + 1), edgeV = new Int32Array(edgeMask + 1);
  const edgeFirst = new Int32Array(edgeMask + 1).fill(-1); // -1 empty, -2 used more than twice
  for (let t = 0; t < triangleCount; t += 1) {
    if (!(t & SLICE)) yield;
    if (collapsed[t]) continue;
    for (let e = 0; e < 3; e += 1) {
      const from = corners[3 * t + e], to = corners[3 * t + ((e + 1) % 3)];
      const u = from < to ? from : to, v = from < to ? to : from;
      let slot = (Math.imul(u, 73856093) ^ Math.imul(v, 19349663)) & edgeMask;
      for (;;) {
        const first = edgeFirst[slot];
        if (first === -1) { edgeU[slot] = u; edgeV[slot] = v; edgeFirst[slot] = 3 * t + e; break; }
        if (edgeU[slot] === u && edgeV[slot] === v) {
          if (first >= 0 && opposite[first] < 0) { opposite[first] = 3 * t + e; opposite[3 * t + e] = first; }
          else if (first >= 0) { opposite[opposite[first]] = -1; opposite[first] = -1; edgeFirst[slot] = -2; }
          break;
        }
        slot = (slot + 1) & edgeMask;
      }
    }
  }

  // ---- coplanar patches, seeded from the largest triangles -------------------------------------
  const BUCKETS = 40;
  const bucketOf = t => (areas[t] > areaFloor && largestArea > 0 ? Math.min(BUCKETS - 2, Math.floor(Math.log2(largestArea / areas[t]))) : BUCKETS - 1);
  const bucketCounts = new Int32Array(BUCKETS + 1);
  for (let t = 0; t < triangleCount; t += 1) {
    if (!(t & SLICE)) yield;
    bucketCounts[bucketOf(t) + 1] += 1;
  }
  for (let b = 0; b < BUCKETS; b += 1) bucketCounts[b + 1] += bucketCounts[b];
  const order = new Int32Array(triangleCount);
  for (let t = 0; t < triangleCount; t += 1) {
    if (!(t & SLICE)) yield;
    order[bucketCounts[bucketOf(t)]++] = t;
  }

  const patchOf = new Int32Array(triangleCount).fill(-1);
  const patchNormal = [];
  const patchOffset = [];
  const stack = new Int32Array(triangleCount);
  let patchCount = 0;
  for (let o = 0; o < triangleCount; o += 1) {
    if (!(o & SLICE)) yield;
    const seed = order[o];
    if (patchOf[seed] >= 0 || collapsed[seed]) continue;
    const id = patchCount;
    patchCount += 1;
    patchOf[seed] = id;
    const nx = normals[3 * seed], ny = normals[3 * seed + 1], nz = normals[3 * seed + 2];
    const anchor = corners[3 * seed];
    const offset = nx * px[anchor] + ny * py[anchor] + nz * pz[anchor];
    patchNormal.push(nx, ny, nz);
    patchOffset.push(offset);
    if (nx === 0 && ny === 0 && nz === 0) continue; // A sliver seeds nothing: its plane is unknown.
    let depth = 0;
    stack[depth++] = seed;
    while (depth) {
      const t = stack[--depth];
      for (let e = 0; e < 3; e += 1) {
        const across = opposite[3 * t + e];
        if (across < 0) continue;
        const s = Math.floor(across / 3);
        if (patchOf[s] >= 0) continue;
        const apex = corners[3 * s + ((across % 3) + 2) % 3];
        if (Math.abs(nx * px[apex] + ny * py[apex] + nz * pz[apex] - offset) > planeTolerance) continue;
        if (areas[s] > areaFloor && nx * normals[3 * s] + ny * normals[3 * s + 1] + nz * normals[3 * s + 2] < 0.9) continue;
        patchOf[s] = id;
        stack[depth++] = s;
      }
    }
  }

  // ---- how the patches meet --------------------------------------------------------------------
  const patchArea = new Float64Array(patchCount);
  const patchPerimeter = new Float64Array(patchCount);
  for (let t = 0; t < triangleCount; t += 1) {
    if (!(t & SLICE)) yield;
    if (patchOf[t] >= 0) patchArea[patchOf[t]] += areas[t];
  }
  const pairOf = new Map();
  const pairA = [], pairB = [], pairLength = [], pairStraight = [], pairLongest = [];
  const pairDirection = [];
  for (let t = 0; t < triangleCount; t += 1) {
    if (!(t & SLICE)) yield;
    if (patchOf[t] < 0) continue;
    for (let e = 0; e < 3; e += 1) {
      const halfEdge = 3 * t + e;
      const across = opposite[halfEdge];
      const other = across >= 0 ? patchOf[Math.floor(across / 3)] : -1;
      if (other === patchOf[t]) continue;
      const from = corners[halfEdge], to = corners[3 * t + ((e + 1) % 3)];
      const dx = px[to] - px[from], dy = py[to] - py[from], dz = pz[to] - pz[from];
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      patchPerimeter[patchOf[t]] += length;
      if (other < 0 || across < halfEdge) continue;
      const a = Math.min(patchOf[t], other), b = Math.max(patchOf[t], other);
      const key = a * patchCount + b;
      let pair = pairOf.get(key);
      if (pair === undefined) {
        pair = pairA.length;
        pairOf.set(key, pair);
        pairA.push(a); pairB.push(b); pairLength.push(0); pairStraight.push(1); pairLongest.push(0);
        pairDirection.push(0, 0, 0);
      }
      pairLength[pair] += length;
      if (length <= 0) continue;
      const ux = dx / length, uy = dy / length, uz = dz / length;
      if (pairLongest[pair] > 0) {
        const c = Math.abs(ux * pairDirection[3 * pair] + uy * pairDirection[3 * pair + 1] + uz * pairDirection[3 * pair + 2]);
        if (c < PARALLEL_COS) pairStraight[pair] = 0;
      }
      if (length > pairLongest[pair]) {
        pairLongest[pair] = length;
        pairDirection[3 * pair] = ux; pairDirection[3 * pair + 1] = uy; pairDirection[3 * pair + 2] = uz;
      }
    }
  }
  const pairCount = pairA.length;
  const patchWidth = new Float64Array(patchCount);
  for (let p = 0; p < patchCount; p += 1) patchWidth[p] = patchPerimeter[p] > 0 ? (2 * patchArea[p]) / patchPerimeter[p] : 0;
  // A strip's axis: the direction of its longest straight join.
  const axisLength = new Float64Array(patchCount);
  const axisDirection = new Float64Array(patchCount * 3);
  for (let i = 0; i < pairCount; i += 1) {
    if (!pairStraight[i]) continue;
    for (const p of [pairA[i], pairB[i]]) {
      if (pairLength[i] > axisLength[p]) {
        axisLength[p] = pairLength[i];
        axisDirection[3 * p] = pairDirection[3 * i]; axisDirection[3 * p + 1] = pairDirection[3 * i + 1]; axisDirection[3 * p + 2] = pairDirection[3 * i + 2];
      }
    }
    if (!(i & SLICE)) yield;
  }
  const smoothAndAlike = i => {
    const a = pairA[i], b = pairB[i];
    const c = patchNormal[3 * a] * patchNormal[3 * b] + patchNormal[3 * a + 1] * patchNormal[3 * b + 1] + patchNormal[3 * a + 2] * patchNormal[3 * b + 2];
    if (c < SMOOTH_COS) return false;
    const low = Math.min(patchWidth[a], patchWidth[b]), high = Math.max(patchWidth[a], patchWidth[b]);
    return low > 0 && high / low < WIDTH_RATIO;
  };

  // ---- strips: a cylinder's facets ---------------------------------------------------------------
  const strips = new Int32Array(patchCount);
  for (let p = 0; p < patchCount; p += 1) strips[p] = p;
  for (let i = 0; i < pairCount; i += 1) {
    if (!pairStraight[i] || !smoothAndAlike(i)) continue;
    const a = pairA[i], b = pairB[i];
    const dx = pairDirection[3 * i], dy = pairDirection[3 * i + 1], dz = pairDirection[3 * i + 2];
    const alongA = Math.abs(dx * axisDirection[3 * a] + dy * axisDirection[3 * a + 1] + dz * axisDirection[3 * a + 2]);
    const alongB = Math.abs(dx * axisDirection[3 * b] + dy * axisDirection[3 * b + 1] + dz * axisDirection[3 * b + 2]);
    if (alongA < PARALLEL_COS || alongB < PARALLEL_COS) continue;
    if (pairLength[i] < 0.5 * Math.min(axisLength[a], axisLength[b])) continue;
    union(strips, a, b);
    if (!(i & SLICE)) yield;
  }
  const stripSize = new Int32Array(patchCount);
  const stripAxis = new Int32Array(patchCount).fill(-1); // The patch that gives its run of strips an axis.
  for (let p = 0; p < patchCount; p += 1) {
    const root = find(strips, p);
    stripSize[root] += 1;
    if (stripAxis[root] < 0 || axisLength[p] > axisLength[stripAxis[root]]) stripAxis[root] = p;
  }
  const inStrips = p => stripSize[find(strips, p)] >= MIN_STRIPS;

  // ---- short runs side by side, each with its own axis: a torus cut up by its own facets ---------
  const columns = new Int32Array(patchCount);
  for (let p = 0; p < patchCount; p += 1) columns[p] = p;
  for (let i = 0; i < pairCount; i += 1) {
    if (!(i & SLICE)) yield;
    if (!inStrips(pairA[i]) || !inStrips(pairB[i]) || !smoothAndAlike(i)) continue;
    const ra = find(strips, pairA[i]), rb = find(strips, pairB[i]);
    if (ra === rb) continue;
    const a = stripAxis[ra], b = stripAxis[rb];
    const along = Math.abs(axisDirection[3 * a] * axisDirection[3 * b] + axisDirection[3 * a + 1] * axisDirection[3 * b + 1] + axisDirection[3 * a + 2] * axisDirection[3 * b + 2]);
    const short = Math.min(axisLength[a], axisLength[b]), long = Math.max(axisLength[a], axisLength[b]);
    if (along < PARALLEL_COS && short > 0 && long / short < WIDTH_RATIO) union(columns, ra, rb);
  }
  const columnRuns = new Int32Array(patchCount);
  for (let p = 0; p < patchCount; p += 1) if (find(strips, p) === p && stripSize[p] >= MIN_STRIPS) columnRuns[find(columns, p)] += 1;

  // ---- what is left of the small patches: a torus, a sphere, a free-form blend ------------------
  const blends = new Int32Array(patchCount);
  for (let p = 0; p < patchCount; p += 1) blends[p] = p;
  for (let i = 0; i < pairCount; i += 1) {
    if (inStrips(pairA[i]) || inStrips(pairB[i]) || !smoothAndAlike(i)) continue;
    union(blends, pairA[i], pairB[i]);
    if (!(i & SLICE)) yield;
  }
  const blendSize = new Int32Array(patchCount);
  for (let p = 0; p < patchCount; p += 1) blendSize[find(blends, p)] += 1;

  // ---- faces -------------------------------------------------------------------------------------
  const faceOfRoot = new Map();
  const faceOfPatch = new Int32Array(patchCount).fill(-1);
  const faceKind = [];
  const groupOf = p => {
    if (!inStrips(p)) return blendSize[find(blends, p)] >= MIN_PATCHES ? `b${find(blends, p)}` : `p${p}`;
    const run = find(strips, p), column = find(columns, run);
    return columnRuns[column] > 1 ? `b-c${column}` : `s${run}`;
  };
  for (let p = 0; p < patchCount; p += 1) {
    if (patchArea[p] <= areaFloor) continue;
    const root = groupOf(p);
    let face = faceOfRoot.get(root);
    if (face === undefined) {
      face = faceKind.length;
      faceOfRoot.set(root, face);
      faceKind.push(root[0]);
    }
    faceOfPatch[p] = face;
  }
  // A sliver belongs to whatever it touches.
  for (let i = 0; i < pairCount; i += 1) {
    const a = pairA[i], b = pairB[i];
    if (faceOfPatch[a] < 0 && faceOfPatch[b] >= 0) faceOfPatch[a] = faceOfPatch[b];
    else if (faceOfPatch[b] < 0 && faceOfPatch[a] >= 0) faceOfPatch[b] = faceOfPatch[a];
  }
  yield;

  const faceCount = faceKind.length;
  const triangleFace = new Int32Array(triangleCount).fill(-1);
  const faceTriangleCount = new Int32Array(faceCount + 1);
  for (let t = 0; t < triangleCount; t += 1) {
    if (!(t & SLICE)) yield;
    if (patchOf[t] < 0) continue;
    const face = faceOfPatch[patchOf[t]];
    triangleFace[t] = face;
    if (face >= 0) faceTriangleCount[face + 1] += 1;
  }
  for (let f = 0; f < faceCount; f += 1) faceTriangleCount[f + 1] += faceTriangleCount[f];
  const faceTriangles = new Int32Array(faceTriangleCount[faceCount]);
  const faceFill = faceTriangleCount.slice();
  for (let t = 0; t < triangleCount; t += 1) {
    if (!(t & SLICE)) yield;
    if (triangleFace[t] >= 0) faceTriangles[faceFill[triangleFace[t]]++] = t;
  }

  // ---- bodies ------------------------------------------------------------------------------------
  const triangleShell = new Int32Array(triangleCount).fill(-1);
  let shellCount = 0;
  for (let s = 0; s < triangleCount; s += 1) {
    if (triangleShell[s] >= 0 || collapsed[s]) continue;
    const shell = shellCount;
    shellCount += 1;
    triangleShell[s] = shell;
    let depth = 0;
    stack[depth++] = s;
    let visited = 0;
    while (depth) {
      const t = stack[--depth];
      if (!(++visited & SLICE)) yield;
      for (let e = 0; e < 3; e += 1) {
        const across = opposite[3 * t + e];
        if (across < 0) continue;
        const next = Math.floor(across / 3);
        if (triangleShell[next] >= 0) continue;
        triangleShell[next] = shell;
        stack[depth++] = next;
      }
    }
  }

  // ---- what each face is -----------------------------------------------------------------------
  const faces = [];
  for (let f = 0; f < faceCount; f += 1) {
    if (!(f & 0xff)) yield;
    const from = faceTriangleCount[f], to = faceTriangleCount[f + 1];
    let area = 0, cx = 0, cy = 0, cz = 0, sx = 0, sy = 0, sz = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const seen = new Set();
    for (let i = from; i < to; i += 1) {
      if (!(i & SLICE)) yield;
      const t = faceTriangles[i];
      const w = areas[t];
      area += w;
      sx += normals[3 * t] * w; sy += normals[3 * t + 1] * w; sz += normals[3 * t + 2] * w;
      for (let c = 0; c < 3; c += 1) {
        const v = corners[3 * t + c];
        cx += (px[v] * w) / 3; cy += (py[v] * w) / 3; cz += (pz[v] * w) / 3;
        seen.add(v);
        if (px[v] < min[0]) min[0] = px[v]; if (px[v] > max[0]) max[0] = px[v];
        if (py[v] < min[1]) min[1] = py[v]; if (py[v] > max[1]) max[1] = py[v];
        if (pz[v] < min[2]) min[2] = pz[v]; if (pz[v] > max[2]) max[2] = pz[v];
      }
    }
    const face = {
      id: f, surface: "curved", area, centroid: area > 0 ? [cx / area, cy / area, cz / area] : [...min],
      bbox: { min, max }, normal: unit3([sx, sy, sz]), shell: triangleShell[faceTriangles[from]], edges: [],
    };
    const firstPatch = patchOf[faceTriangles[from]];
    if (faceKind[f] === "p") {
      face.surface = "plane";
      face.normal = [patchNormal[3 * firstPatch], patchNormal[3 * firstPatch + 1], patchNormal[3 * firstPatch + 2]];
      face.offset = patchOffset[firstPatch];
    } else if (faceKind[f] === "s") {
      const fit = fitCylinder(f, seen);
      if (fit) Object.assign(face, { surface: "cylinder" }, fit);
    }
    faces.push(face);
  }

  function fitCylinder(faceId, vertices) {
    // The axis: the strips' shared direction, in one sense.
    let ax = 0, ay = 0, az = 0;
    for (let i = 0; i < pairCount; i += 1) {
      if (!pairStraight[i] || faceOfPatch[pairA[i]] !== faceId || faceOfPatch[pairB[i]] !== faceId) continue;
      const sign = pairDirection[3 * i] * ax + pairDirection[3 * i + 1] * ay + pairDirection[3 * i + 2] * az < 0 ? -1 : 1;
      ax += sign * pairDirection[3 * i] * pairLength[i]; ay += sign * pairDirection[3 * i + 1] * pairLength[i]; az += sign * pairDirection[3 * i + 2] * pairLength[i];
    }
    const axis = unit3([ax, ay, az]);
    if (!norm3(axis)) return null;
    const [u, v] = planeBasis(axis);
    const step = Math.max(1, Math.floor(vertices.size / MAX_FIT_POINTS));
    const projected = [];
    let k = 0;
    for (const vertex of vertices) {
      if (k++ % step) continue;
      const p = [px[vertex], py[vertex], pz[vertex]];
      projected.push(dot3(p, u), dot3(p, v));
    }
    const circle = fitCircle2D(projected);
    if (!circle || circle.residual > fitLimit(circle.radius, planeTolerance)) return null;
    const center = [u[0] * circle.cx + v[0] * circle.cy, u[1] * circle.cx + v[1] * circle.cy, u[2] * circle.cx + v[2] * circle.cy];
    let outward = 0;
    for (let i = faceTriangleCount[faceId]; i < faceTriangleCount[faceId + 1]; i += 1) {
      const t = faceTriangles[i];
      const c = corners[3 * t];
      outward += areas[t] * (normals[3 * t] * (px[c] - center[0]) + normals[3 * t + 1] * (py[c] - center[1]) + normals[3 * t + 2] * (pz[c] - center[2]));
    }
    return { axis, center, radius: circle.radius, convex: outward > 0, sweep: sweepOf(projected, circle.cx, circle.cy), residual: circle.residual };
  }

  // ---- edges: where two faces meet, chained ------------------------------------------------------
  const groups = new Map();
  for (let t = 0; t < triangleCount; t += 1) {
    if (!(t & SLICE)) yield;
    if (triangleFace[t] < 0) continue;
    for (let e = 0; e < 3; e += 1) {
      const halfEdge = 3 * t + e;
      const across = opposite[halfEdge];
      const other = across >= 0 ? triangleFace[Math.floor(across / 3)] : -1;
      if (other === triangleFace[t] || (across >= 0 && across < halfEdge)) continue;
      const first = other < 0 ? triangleFace[t] : Math.min(triangleFace[t], other);
      const second = other < 0 ? -1 : Math.max(triangleFace[t], other);
      const key = first * (faceCount + 1) + second + 1;
      let group = groups.get(key);
      if (!group) { group = { first, second, from: [], to: [], angle: [] }; groups.set(key, group); }
      group.from.push(corners[halfEdge]);
      group.to.push(corners[3 * t + ((e + 1) % 3)]);
      if (across < 0) group.angle.push(null);
      else {
        const s = Math.floor(across / 3);
        const c = normals[3 * t] * normals[3 * s] + normals[3 * t + 1] * normals[3 * s + 1] + normals[3 * t + 2] * normals[3 * s + 2];
        group.angle.push((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
      }
    }
  }
  const edges = [];
  for (const group of groups.values()) {
    yield;
    for (const chain of chainsOf(group)) {
      const edge = describeChain(chain, group, edges.length);
      edges.push(edge);
      faces[group.first].edges.push(edge.id);
      if (group.second >= 0) faces[group.second].edges.push(edge.id);
    }
  }

  function chainsOf(group) {
    const touching = new Map();
    const count = group.from.length;
    for (let i = 0; i < count; i += 1) {
      for (const vertex of [group.from[i], group.to[i]]) {
        let list = touching.get(vertex);
        if (!list) { list = []; touching.set(vertex, list); }
        list.push(i);
      }
    }
    const used = new Uint8Array(count);
    const chains = [];
    const walk = (startSegment, startVertex) => {
      const vertices = [startVertex];
      const segments = [];
      let vertex = startVertex, segment = startSegment;
      while (segment >= 0 && !used[segment]) {
        used[segment] = 1;
        segments.push(segment);
        vertex = group.from[segment] === vertex ? group.to[segment] : group.from[segment];
        vertices.push(vertex);
        const options = touching.get(vertex);
        segment = options.length === 2 ? (options[0] === segment ? options[1] : options[0]) : -1;
      }
      return { vertices, segments };
    };
    // Open chains first, from their ends (and wherever more than two segments meet); then the loops.
    for (const [vertex, list] of touching) {
      if (list.length === 2) continue;
      for (const segment of list) if (!used[segment]) chains.push(walk(segment, vertex));
    }
    for (let i = 0; i < count; i += 1) if (!used[i]) chains.push(walk(i, group.from[i]));
    return chains;
  }

  function describeChain({ vertices, segments }, group, id) {
    const closed = vertices.length > 2 && vertices[0] === vertices[vertices.length - 1];
    const points = new Float64Array(vertices.length * 3);
    vertices.forEach((v, i) => { points[3 * i] = px[v]; points[3 * i + 1] = py[v]; points[3 * i + 2] = pz[v]; });
    let length = 0, weighted = 0, measured = 0;
    segments.forEach((segment, i) => {
      const piece = Math.hypot(points[3 * i + 3] - points[3 * i], points[3 * i + 4] - points[3 * i + 1], points[3 * i + 5] - points[3 * i + 2]);
      length += piece;
      if (group.angle[segment] !== null) { weighted += group.angle[segment] * piece; measured += piece; }
    });
    const edge = {
      id, faces: [group.first, group.second], points, closed, length, shape: "curve",
      start: [points[0], points[1], points[2]], end: [points[points.length - 3], points[points.length - 2], points[points.length - 1]],
      angle: measured > 0 ? weighted / measured : null,
    };
    return Object.assign(edge, chainShape(points, closed, planeTolerance));
  }

  return {
    triangleCount, faces, edges,
    shells: collectShells(faces, shellCount),
    faceOfTriangle: t => triangleFace[t],
    trianglesOfFace: f => faceTriangles.subarray(faceTriangleCount[f], faceTriangleCount[f + 1]),
  };
}

function collectShells(faces, shellCount) {
  const shells = Array.from({ length: shellCount }, (_, id) => ({ id, area: 0, faces: 0, bbox: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } }));
  for (const face of faces) {
    const shell = shells[face.shell];
    shell.area += face.area;
    shell.faces += 1;
    for (let i = 0; i < 3; i += 1) {
      shell.bbox.min[i] = Math.min(shell.bbox.min[i], face.bbox.min[i]);
      shell.bbox.max[i] = Math.max(shell.bbox.max[i], face.bbox.max[i]);
    }
  }
  return shells.filter(shell => shell.faces > 0);
}

/** `meshFeatureSteps` run through at once. */
export function buildMeshFeatures(positions, index = null) {
  const steps = meshFeatureSteps(positions, index);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * The edge bounding `faceId` nearest `point`, if within `tolerance` of it (both in the mesh's own units).
 * @returns {{ edge: object, distance: number } | null}
 */
export function nearestFeatureEdge(features, faceId, point, tolerance) {
  const face = features.faces[faceId];
  if (!face) return null;
  let best = null;
  for (const id of face.edges) {
    const edge = features.edges[id];
    const points = edge.points;
    for (let i = 0; i + 3 < points.length; i += 3) {
      const ax = points[i], ay = points[i + 1], az = points[i + 2];
      const bx = points[i + 3] - ax, by = points[i + 4] - ay, bz = points[i + 5] - az;
      const wx = point[0] - ax, wy = point[1] - ay, wz = point[2] - az;
      const lengthSquared = bx * bx + by * by + bz * bz;
      const t = lengthSquared > 0 ? Math.max(0, Math.min(1, (wx * bx + wy * by + wz * bz) / lengthSquared)) : 0;
      const distance = Math.hypot(wx - bx * t, wy - by * t, wz - bz * t);
      if (distance <= tolerance && (!best || distance < best.distance)) best = { edge, distance };
    }
  }
  return best;
}
