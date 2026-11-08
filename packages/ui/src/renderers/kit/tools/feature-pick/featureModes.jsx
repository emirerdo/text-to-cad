import ToolModeMenu from "../ToolModeMenu.jsx";

export const FEATURE_MODE = Object.freeze({ ALL: "all", PARTS: "parts", FACES: "faces", EDGES: "edges", POINTS: "points" });

const SVG = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };
const CUBE = "M12 2.5 20.5 7.25v9.5L12 21.5l-8.5-4.75v-9.5Z";
const CUBE_SEAMS = "M3.5 7.25 12 12l8.5-4.75M12 12v9.5";
const faintCube = <g strokeWidth={1.5} strokeOpacity="0.45"><path d={CUBE} /><path d={CUBE_SEAMS} /></g>;
// One glyph per mode, on the Select tool's grid: the element a pick takes is the part drawn solid.
const GLYPHS = Object.freeze({
  all: <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />,
  parts: <g><path d={CUBE} /><path d={CUBE_SEAMS} /></g>,
  faces: <>{faintCube}<path d="M12 2.5 20.5 7.25 12 12 3.5 7.25Z" fill="currentColor" /></>,
  edges: <>{faintCube}<path d="M12 12v9.5" strokeWidth={3.5} /></>,
  points: <><circle cx="12" cy="12" r="8.5" strokeWidth={1.5} strokeOpacity="0.45" /><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" /></>,
});

/** The Select tool's button: its mode's glyph (`data-select-mode`). */
export function FeatureModeIcon({ mode, ...props }) {
  return <svg {...SVG} data-select-mode={mode} {...props}>{GLYPHS[mode] ?? GLYPHS.all}</svg>;
}

/** Select's modes where a pick is read off the triangles. `parts`: whether this file names parts of its own. */
export const featureModes = ({ parts }) => [
  { id: FEATURE_MODE.ALL, label: "All" },
  ...(parts ? [{ id: FEATURE_MODE.PARTS, label: "Parts" }] : []),
  { id: FEATURE_MODE.FACES, label: "Faces" },
  { id: FEATURE_MODE.EDGES, label: "Edges" },
  { id: FEATURE_MODE.POINTS, label: "Points" },
];

/** Select's mode, as the small sliders button in its panel's heading. */
export function FeatureModeMenu({ mode, onModeChange, parts, disabled = false }) {
  const modes = featureModes({ parts }).map(item => ({ ...item, icon: <FeatureModeIcon mode={item.id} className="size-3.5" aria-hidden="true" /> }));
  return <ToolModeMenu label="Select mode" modes={modes} value={mode} onChange={onModeChange} disabled={disabled} />;
}
