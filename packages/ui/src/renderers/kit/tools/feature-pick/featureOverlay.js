import { createScreenSpaceLineSegments } from "@text-to-cad/core/common/renderEdges.js";
import { REFERENCE_HOVER_COLOR, REFERENCE_SELECTED_COLOR } from "@text-to-cad/core/lib/viewer/referenceGeometry.js";

// What is picked or under the pointer, drawn over the model: a tint on a face, a heavy line on an
// edge, a numbered pin on each pick. It hangs from the viewport's scene, not from the file's: the
// file's scene owns its meshes' materials and bounds, and a pin under a mesh scaled 0.001 would
// inherit the scale. Being in the scene, it follows the camera with no work and is in a capture.

const HOVER = Object.freeze({ color: REFERENCE_HOVER_COLOR, fill: 0.34, line: 2.5 });
const SELECTED = Object.freeze({ color: REFERENCE_SELECTED_COLOR, fill: 0.42, line: 3 });
const PIN_PX = 22;
const PIN_ORDER = 40;

function pinTexture(THREE, ordinal) {
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  context.fillStyle = REFERENCE_SELECTED_COLOR;
  context.fill();
  context.lineWidth = 6;
  context.strokeStyle = "#ffffff";
  context.stroke();
  context.fillStyle = "#ffffff";
  context.font = "600 52px -apple-system, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(ordinal), size / 2, size / 2 + 3);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function trianglePositions(mesh, triangles) {
  const position = mesh.geometry.attributes.position;
  const index = mesh.geometry.index;
  const out = new Float32Array(triangles.length * 9);
  let w = 0;
  for (const triangle of triangles) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = index ? index.getX(3 * triangle + corner) : 3 * triangle + corner;
      out[w++] = position.getX(vertex); out[w++] = position.getY(vertex); out[w++] = position.getZ(vertex);
    }
  }
  return out;
}

function polylineSegments(polylines) {
  let count = 0;
  for (const points of polylines) count += Math.max(0, points.length / 3 - 1);
  const out = new Float32Array(count * 6);
  let w = 0;
  for (const points of polylines) {
    for (let i = 0; i + 3 < points.length; i += 3) {
      out[w++] = points[i]; out[w++] = points[i + 1]; out[w++] = points[i + 2];
      out[w++] = points[i + 3]; out[w++] = points[i + 4]; out[w++] = points[i + 5];
    }
  }
  return out;
}

/** The objects showing one feature, placed where its mesh is. */
function drawFeature(runtime, entry, style) {
  const { THREE } = runtime;
  const { mesh, features, resolved } = entry;
  mesh.updateWorldMatrix(true, false);
  const place = object => { object.matrixAutoUpdate = false; object.matrix.copy(mesh.matrixWorld); object.matrixWorldNeedsUpdate = true; return object; };
  const objects = [];
  const lines = polylines => {
    const line = createScreenSpaceLineSegments(runtime, polylineSegments(polylines), {
      color: style.color, opacity: 1, lineWidth: style.line, renderOrder: 26, depthTest: true, depthWrite: false,
    });
    if (line) objects.push(place(line));
  };
  if (resolved.kind === "face") {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(trianglePositions(mesh, features.trianglesOfFace(resolved.faceId)), 3));
    const material = new THREE.MeshBasicMaterial({
      color: style.color, transparent: true, opacity: style.fill, depthTest: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const fill = new THREE.Mesh(geometry, material);
    fill.renderOrder = 25;
    objects.push(place(fill));
    lines(features.faces[resolved.faceId].edges.map(id => features.edges[id].points));
  } else if (resolved.kind === "edge") {
    lines([features.edges[resolved.edgeId].points]);
  }
  return objects;
}

function drawPin(runtime, point, ordinal) {
  const { THREE } = runtime;
  const material = new THREE.SpriteMaterial({ map: pinTexture(THREE, ordinal), depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false });
  const pin = new THREE.Sprite(material);
  pin.position.copy(point);
  pin.renderOrder = PIN_ORDER;
  // On-screen size held in pixels, whatever the camera: unattenuated, a sprite's size is its scale over the projection's.
  pin.onBeforeRender = (renderer, _scene, camera) => {
    const height = renderer.domElement.clientHeight || 1;
    pin.scale.setScalar((2 * PIN_PX) / (height * camera.projectionMatrix.elements[5]));
    pin.updateMatrixWorld(true);
  };
  return pin;
}

function dispose(objects) {
  for (const object of objects) {
    object.removeFromParent();
    object.userData.beforeDispose?.();
    object.geometry?.dispose();
    object.material?.map?.dispose();
    object.material?.dispose();
  }
}

/** The overlay of one viewport. `setHover`/`setSelected` redraw; the caller asks for the frame. */
export function createFeatureOverlay(runtime) {
  const root = new runtime.THREE.Group();
  root.name = "feature-pick-overlay";
  runtime.scene.add(root);
  let hovered = [], selected = [];
  const show = objects => { for (const object of objects) root.add(object); return objects; };
  return {
    setHover(entry) {
      dispose(hovered);
      hovered = entry ? show(drawFeature(runtime, entry, HOVER)) : [];
    },
    /** `entries` in order: the first is pin 1. */
    setSelected(entries) {
      dispose(selected);
      selected = show(entries.flatMap((entry, index) => [...drawFeature(runtime, entry, SELECTED), drawPin(runtime, entry.worldPoint, index + 1)]));
    },
    dispose() {
      dispose(hovered); dispose(selected);
      hovered = []; selected = [];
      root.removeFromParent();
    },
  };
}
