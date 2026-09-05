import { defineMemory } from "eve/memory";
import { selfImprovement } from "eve/self-improvement";

export default defineMemory({
  description: "Learn operating rules for this deployment, and adopt the approved ones.",
  provider: selfImprovement(),
  // Directives describe the agent, not one caller, so the slot only decides
  // whose turns the agent may learn from.
  scope: "agent",
});
