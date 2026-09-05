import { defineMemory } from "eve/memory";
import { learningMemory } from "eve/memory/learning";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "Remember how this person works and what has worked on this computer before.",
  provider: learningMemory(),
  scope: byPrincipal,
});
