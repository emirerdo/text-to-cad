import { createPromptContext, formatPromptMessage, referencePart, textPart } from "@text-to-cad/core/prompt";

const stem = path => String(path || "").split("/").pop().replace(/\.[^.]+$/, "") || "view";

/** What a sketch is saved and attached as: the view of `bracket.step` with its ink is `bracket-sketch.png`. */
export const sketchName = resource => `${stem(resource.kind === "url" ? new URL(resource.url).pathname : resource.path)}-sketch.png`;

/** The selection a Quick Edit attaches: what is picked in the file, not the file itself, which it always attaches. */
export const quickEditSelection = references => references.filter(reference => reference.target.kind !== "whole-resource");

/**
 * A Quick Edit as one prompt context: what the person wrote, the file on screen (always), the
 * selection in it (`references`, in the prompt grammar), and the view with the sketch drawn over
 * it (`sketch`, a PNG that may still be encoding). Built at the press, from what is live then.
 */
export function createQuickEditContext({ resource, references = [], text, sketch = null }) {
  const parts = [
    textPart(String(text || "").trim(), "text"),
    referencePart({ resource: { ...resource }, target: { kind: "whole-resource" } }, "file"),
    ...quickEditSelection(references).map((reference, index) => referencePart({ ...reference, resource: { ...reference.resource } }, `reference-${index}`)),
  ];
  if (sketch) parts.push({ id: "sketch", kind: "attachment", label: "Sketch", name: sketchName(resource), mimeType: "image/png", content: sketch, about: ["file"] });
  return createPromptContext(parts);
}

/**
 * A Quick Edit as the person copies it: its references by their files' absolute paths, and its
 * sketch by the path it was saved at, since text cannot carry a picture.
 */
export function copiedQuickEdit(context, { sketchPath = null } = {}) {
  return formatPromptMessage(context, { attachmentPath: () => sketchPath });
}

/**
 * What is selected, as an agent's context holds it: the same message a copy gives, the paths it
 * names (a server may name them more exactly), and the view to save beside it. Nothing to say is
 * an empty text.
 */
export function agentSelection({ resource, references = [], text = "", picture = null, pictureKey = "" }) {
  const chosen = quickEditSelection(references);
  if (!chosen.length && !String(text).trim() && !picture) return { text: "", paths: [], picture: null, pictureKey: "", pictureName: "" };
  const paths = [resource, ...chosen.map(reference => reference.resource)].filter(item => item.kind === "workspace-file").map(item => item.path);
  return {
    text: formatPromptMessage(createQuickEditContext({ resource, references: chosen, text })),
    paths: [...new Set(paths)], picture, pictureKey,
    pictureName: `${stem(resource.kind === "url" ? new URL(resource.url).pathname : resource.path)}-pick.png`,
  };
}
