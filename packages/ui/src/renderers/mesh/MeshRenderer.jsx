import { useCallback, useMemo, useRef } from "react";
import { EDGELESS_VIEW_FEATURES } from "@text-to-cad/core/common/viewSettings.js";
import { useViewerHost } from "../../host/context.js";
import RendererShell from "../kit/shell/RendererShell.jsx";
import { SHELL_TOOL, useRendererShell } from "../kit/shell/useRendererShell.js";
import { noGeometryAlert } from "../kit/status/loadAlerts.js";
import FeaturePick, { useFeaturePicks } from "../kit/tools/feature-pick/FeaturePick.jsx";
import { FeatureModeIcon, FeatureModeMenu } from "../kit/tools/feature-pick/featureModes.jsx";
import ToolPanel from "../kit/tools/ToolPanel.jsx";
import { createToolModes } from "../kit/tools/toolModes.js";
import { useDeclinedSelectReference, useWorkspaceDocument, workspaceLoadAlert } from "../workspace/useWorkspaceDocument.js";
import { MESH_DECLINED_LIVE_COMMANDS } from "./tools.js";
import { useMeshScene } from "./useMeshScene.js";

const LIVE = Object.freeze({ declined: MESH_DECLINED_LIVE_COMMANDS });
const SELECT = "select";
// With an agent to tell, a mesh can be pointed at: its faces, edges and points are read off the triangles.
const AGENT_TOOL_MODES = createToolModes({ defaultMode: SELECT, modes: { [SELECT]: {}, [SHELL_TOOL.DRAW]: { toggles: true } } });
const SELECT_PANEL = Object.freeze({ id: "select", label: "Select", startsClosed: false });
const NO_TOOLS = Object.freeze([]);
// A mesh file carries no unit: an STL is read as millimetres, as every slicer does.
const STL_UNITS_TO_MM = 1;

function MeshSurface({ view, data }) {
  const document = useWorkspaceDocument({ view, data });
  const loaded = useMeshScene({ entry: document.entry, resources: document.client.resources });
  const scene = loaded.scene;
  const loadAlert = useMemo(() => workspaceLoadAlert({
    catalogError: document.catalogError, error: loaded.error, modelKey: document.modelKey, hasScene: Boolean(scene)
  }) || (loaded.empty ? noGeometryAlert(document.modelKey) : null),
  [document.catalogError, loaded.error, loaded.empty, document.modelKey, scene]);

  const agent = Boolean(useViewerHost().agentContext);
  const picks = useFeaturePicks({ scene });
  const picksRef = useRef(picks);
  picksRef.current = picks;
  const escape = useMemo(() => ({
    active: picks.active,
    handle: () => { if (!picksRef.current.active) return false; picksRef.current.clear(); return true; }
  }), [picks.active]);

  const shell = useRendererShell({
    view, services: document.services, resource: document.resource, modelKey: document.modelKey, revisionKey: loaded.revision,
    features: EDGELESS_VIEW_FEATURES, previewable: true, scene,
    load: { busy: loaded.busy && !scene, updating: loaded.busy && Boolean(scene), progress: loaded.progress, alert: loadAlert },
    live: LIVE, ...(agent ? { toolModes: AGENT_TOOL_MODES, escape } : {})
  });
  useDeclinedSelectReference(document);
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const requestFrame = useCallback(() => shellRef.current.requestFrame?.(), []);

  const file = String(document.entry?.file || "").trim() || document.modelKey;
  const describePart = useCallback(() => ({ name: file.split("/").pop().replace(/\.[^.]+$/, ""), path: file }), [file]);
  if (!agent) return <RendererShell shell={shell} tools={NO_TOOLS} />;

  const selecting = !shell.previewing && shell.toolMode === SELECT;
  const tools = [
    shell.tools.own({ id: SELECT, label: "Select", icon: <FeatureModeIcon mode={picks.mode} className="size-3.5" aria-hidden="true" />, panel: SELECT_PANEL }),
    shell.tools.draw,
  ];
  const toolPanels = <ToolPanel id="select" title="Select" label="Select" fit="details" closable collapsible={false} hidden={!selecting}
    actions={<FeatureModeMenu mode={picks.mode} onModeChange={picks.setMode} parts={false} />}>
    <p className="px-2 pb-1.5 text-tiny text-muted-foreground">Click a face, edge or point. Shift adds another.</p>
  </ToolPanel>;
  return <RendererShell shell={shell} tools={tools} toolPanels={toolPanels} references={picks.references} onClearReferences={picks.clear}
    viewportOverlay={viewport => <FeaturePick viewport={viewport} scene={scene} enabled={selecting && Boolean(scene)} picks={picks} describePart={describePart}
      rootUnitsToMm={STL_UNITS_TO_MM} requestFrame={requestFrame} />} />;
}

export default function MeshRenderer(props) {
  const { data, ...view } = props;
  return <MeshSurface key={JSON.stringify([view.source.id, view.file.path])} view={view} data={data} />;
}
