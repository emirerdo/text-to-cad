import assert from "node:assert/strict";
import test from "node:test";
import { agentSelection } from "./quickEditPrompt.js";

const resource = { kind: "workspace-file", path: "/work/preview/design.urdf" };
const feature = path => ({ resource: { kind: "workspace-file", path }, target: { kind: "mesh-feature", feature: "face", summary: `1 face · mini · ${path}\n  plane` }, label: "1 face · mini" });

test("what is picked is told as the copied message is, with every path it names once", () => {
  const picked = agentSelection({ resource, references: [feature("/work/mini.stl"), feature("/work/mini.stl")], text: "Lower this." });
  assert.match(picked.text, /^Lower this\.\n\nFile: \/work\/preview\/design\.urdf\nReferences:\n1 face/);
  assert.deepEqual(picked.paths, ["/work/preview/design.urdf", "/work/mini.stl"]);
  assert.equal(picked.pictureName, "design-pick.png");
});

test("nothing picked and nothing written is nothing to say", () => {
  assert.deepEqual(agentSelection({ resource }), { text: "", paths: [], picture: null, pictureKey: "", pictureName: "" });
});

test("a whole file is not a selection of anything in it", () => {
  const whole = { resource, target: { kind: "whole-resource" } };
  assert.equal(agentSelection({ resource, references: [whole] }).text, "");
});

test("a note alone still says which file it is about", () => {
  assert.match(agentSelection({ resource, text: "Too tall." }).text, /^Too tall\.\n\nFile: /);
});
