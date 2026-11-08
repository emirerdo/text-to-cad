import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { meshFeatureSteps } from "@text-to-cad/core/lib/viewer/meshFeatures.js";
import { usePointerPick } from "../select/usePointerPick.js";
import { featureKey, featureLabel, featureRecord, formatFeatureRecord, resolveFeature, viewWords } from "./featureRecord.js";
import { FEATURE_MODE } from "./featureModes.jsx";
import { createFeatureOverlay } from "./featureOverlay.js";

const EMPTY = Object.freeze([]);
// How near a pointer must be to an edge for All to take the edge instead of the face.
const EDGE_PIXELS = 6;
const SLICE_MS = 6;

// A mesh's features, read off its triangles once and in slices, so the first touch of a
// 700 000 triangle part does not stop the viewport. Keyed by geometry: visuals share them.
const featureCache = new WeakMap();

function featuresOf(geometry) {
  const known = featureCache.get(geometry);
  if (known) return known;
  const entry = { ready: null, promise: null };
  featureCache.set(geometry, entry);
  const steps = meshFeatureSteps(geometry.attributes.position.array, geometry.index?.array ?? null);
  entry.promise = new Promise((resolve) => {
    const slice = () => {
      const until = performance.now() + SLICE_MS;
      for (;;) {
        const step = steps.next();
        if (step.done) { entry.ready = step.value; resolve(step.value); return; }
        if (performance.now() >= until) break;
      }
      setTimeout(slice, 0);
    };
    slice();
  });
  return entry;
}

/** One world unit, in pixels' worth at a distance from the camera. */
function worldPerPixel(camera, height, distance) {
  if (camera.isPerspectiveCamera) return (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / (camera.zoom || 1) / height;
  return (camera.top - camera.bottom) / (camera.zoom || 1) / height;
}

/**
 * What is picked on a mesh: the renderer's state (its references go to Quick Edit), while the
 * viewport's side is `FeaturePick`. Picks belong to one scene: a rebuilt model has other triangles.
 *
 * @param {{ scene: object | null, extra?: readonly object[] }} options  `extra`: whole parts picked elsewhere (a tree), told after the picks.
 */
export function useFeaturePicks({ scene, extra = EMPTY }) {
  const [mode, setMode] = useState(FEATURE_MODE.ALL);
  const [held, setHeld] = useState({ scene: null, entries: EMPTY });
  const entries = held.scene === scene ? held.entries : EMPTY;
  const change = useCallback((next) => setHeld(current => {
    const before = current.scene === scene ? current.entries : EMPTY;
    const after = next(before);
    return after === before && current.scene === scene ? current : { scene, entries: after };
  }), [scene]);
  const clear = useCallback(() => change(() => EMPTY), [change]);
  const pick = useCallback((entry, multiSelect) => change((before) => {
    const present = before.some(item => item.key === entry.key);
    if (multiSelect) return present ? before.filter(item => item.key !== entry.key) : [...before, entry];
    return present && before.length === 1 ? EMPTY : [entry];
  }), [change]);
  const references = useMemo(() => [...entries.map(entry => entry.record), ...extra].map((record, index) => ({
    resource: { kind: "workspace-file", path: record.part.path },
    target: { kind: "mesh-feature", feature: record.kind, summary: formatFeatureRecord(record, index + 1) },
    label: featureLabel(record, index + 1),
  })), [entries, extra]);
  return useMemo(() => ({ mode, setMode, entries, references, active: entries.length > 0, pick, clear }), [mode, entries, references, pick, clear]);
}

/**
 * The viewport's side of picking on a mesh: which feature the pointer is on, its highlight, and
 * what a click measures. Draws nothing of its own in the DOM.
 *
 * @param {object} props
 * @param {object} props.viewport  What `RendererShell`'s `viewportOverlay` is given.
 * @param {object | null} props.scene
 * @param {boolean} props.enabled
 * @param {ReturnType<typeof useFeaturePicks>} props.picks
 * @param {(hit: object) => { name: string, path: string } | null} props.describePart  The part a hit struck, or null to pick nothing there.
 * @param {number} props.rootUnitsToMm  Millimetres per unit of the scene's own frame.
 * @param {() => void} props.requestFrame  Show a changed highlight.
 * @param {(multiSelect: boolean) => void} [props.onBeforePick]  A press on the model is about to change what is picked.
 */
export default function FeaturePick({ viewport, scene, enabled, picks, describePart, rootUnitsToMm, requestFrame, onBeforePick = null }) {
  const overlayRef = useRef(null);
  const { runtimeRef, hostRef, viewerReadyTick } = viewport;
  const latest = useRef(null);
  latest.current = { picks, describePart, rootUnitsToMm, requestFrame, onBeforePick };

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.scene || !scene) return undefined;
    const overlay = createFeatureOverlay(runtime);
    overlayRef.current = overlay;
    return () => { overlay.dispose(); overlayRef.current = null; latest.current.requestFrame(); };
  }, [runtimeRef, viewerReadyTick, scene]);

  useEffect(() => {
    overlayRef.current?.setSelected(picks.entries);
    latest.current.requestFrame();
  }, [picks.entries, viewerReadyTick, scene]);

  /** The feature a hit is on, under the mode, once its mesh's features are read; null while they are not. */
  const locate = useCallback((hit, features) => {
    const runtime = runtimeRef.current;
    const mesh = hit.object;
    const camera = runtime.camera;
    const height = hostRef.current?.getBoundingClientRect().height || 1;
    const meshScale = mesh.getWorldScale(new runtime.THREE.Vector3()).x || 1;
    const local = mesh.worldToLocal(hit.point.clone()).toArray();
    const tolerance = (EDGE_PIXELS * worldPerPixel(camera, height, camera.position.distanceTo(hit.point))) / meshScale;
    return resolveFeature(features, { triangle: hit.faceIndex, point: local, mode: latest.current.picks.mode, tolerance });
  }, [runtimeRef, hostRef]);

  const hoveredKey = useRef("");
  const hoverOn = useCallback((entry) => {
    const key = entry ? `${entry.mesh.uuid}/${featureKey(entry.resolved)}` : "";
    if (key === hoveredKey.current) return;
    hoveredKey.current = key;
    overlayRef.current?.setHover(entry);
    latest.current.requestFrame();
  }, []);
  // Leaving the tool leaves nothing hovered.
  useEffect(() => { if (!enabled) hoverOn(null); }, [enabled, hoverOn]);

  const onHover = useCallback((hit) => {
    if (!hit?.object || hit.faceIndex === undefined) { hoverOn(null); return; }
    const cached = featuresOf(hit.object.geometry);
    if (!cached.ready) { hoverOn(null); return; }
    const resolved = locate(hit, cached.ready);
    hoverOn(resolved ? { mesh: hit.object, features: cached.ready, resolved } : null);
  }, [locate, hoverOn]);

  const onPick = useCallback(async (hit, { multiSelect }) => {
    latest.current.onBeforePick?.(multiSelect);
    if (!hit?.object || hit.faceIndex === undefined) { if (!multiSelect) latest.current.picks.clear(); return; }
    const features = await featuresOf(hit.object.geometry).promise;
    const runtime = runtimeRef.current;
    const part = latest.current.describePart(hit);
    const resolved = part && runtime ? locate(hit, features) : null;
    if (!resolved) return;
    latest.current.picks.pick(measure({ runtime, scene, hit, features, resolved, part, rootUnitsToMm: latest.current.rootUnitsToMm, describePart: latest.current.describePart }), multiSelect);
  }, [runtimeRef, scene, locate]);

  usePointerPick({ viewport, scene, enabled, onPick, onHover, sameHit: () => false });
  return null;
}

/** A pick, measured where it is: its frames, what lies behind and ahead of it, and how it was seen. */
function measure({ runtime, scene, hit, features, resolved, part, rootUnitsToMm, describePart }) {
  const { THREE, camera } = runtime;
  const mesh = hit.object;
  const root = scene.object3D;
  mesh.updateWorldMatrix(true, false);
  root.updateWorldMatrix(true, false);
  const meshToRoot = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld);
  const meshScale = new THREE.Vector3().setFromMatrixColumn(mesh.matrixWorld, 0).length() || 1;
  const unitsToMm = new THREE.Vector3().setFromMatrixColumn(meshToRoot, 0).length() * rootUnitsToMm;
  const frame = {
    unitsToMm,
    toAssembly: point => new THREE.Vector3(...point).applyMatrix4(meshToRoot).multiplyScalar(rootUnitsToMm).toArray(),
    directionToAssembly: vector => new THREE.Vector3(...vector).transformDirection(meshToRoot).toArray(),
  };
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bbox = { min: mesh.geometry.boundingBox.min.toArray(), max: mesh.geometry.boundingBox.max.toArray() };

  // Two rays along the triangle's own normal: into the material, and out of it.
  const position = mesh.geometry.attributes.position, index = mesh.geometry.index;
  const corner = i => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(3 * hit.faceIndex + i) : 3 * hit.faceIndex + i);
  const [a, b, c] = [corner(0), corner(1), corner(2)];
  const localNormal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  const normal = localNormal.clone().transformDirection(mesh.matrixWorld);
  const worldToMm = unitsToMm / meshScale;
  const nudge = 1e-4 / worldToMm;
  const raycaster = new THREE.Raycaster();
  raycaster.set(hit.point.clone().addScaledVector(normal, -nudge), normal.clone().negate());
  const inside = raycaster.intersectObject(mesh, false)[0];
  const behind = inside ? (inside.distance + nudge) * worldToMm : null;
  const outward = new THREE.Ray(hit.point.clone().addScaledVector(normal, nudge), normal);
  const beyond = scene.pick(outward);
  const beyondPart = beyond?.point ? describePart(beyond) : null;
  const ahead = beyondPart ? { name: beyondPart.name, distance: beyond.point.distanceTo(hit.point) * worldToMm } : null;

  const toCamera = camera.getWorldDirection(new THREE.Vector3()).negate().transformDirection(new THREE.Matrix4().copy(root.matrixWorld).invert());
  const record = featureRecord({ features, resolved, part: { ...part, bbox, shells: features.shells.length }, frame, view: viewWords(toCamera.toArray()), behind, ahead });
  return { key: `${mesh.uuid}/${featureKey(resolved)}`, mesh, features, resolved, record, worldPoint: hit.point.clone() };
}
