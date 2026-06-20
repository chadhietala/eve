import { defineEval } from "eve/evals";

/**
 * Working-memory smoke: a fact persisted to `/memory` in one turn is recalled
 * from memory in a later turn of the same thread.
 *
 * Both `t.send` calls run in the same session/thread, so working memory keyed
 * by the thread persists across the turns. The recalled fact is unusual and
 * specific so a correct answer cannot be a lucky guess.
 */
export default defineEval({
  description: "Working memory smoke: cross-turn recall from /memory.",
  async test(t) {
    const first = await t.send(
      "My project's deploy token rotates every 14 days and the owner is Priya. " +
        "Save this to your memory under /memory so you can recall it later.",
    );
    first.expectOk();
    t.calledTool("write_file", { isError: false });

    const second = await t.send(
      "Look in your memory and tell me who owns the deploy token rotation. " +
        "Do not guess — read it from /memory.",
    );
    second.expectOk();
    t.messageIncludes(/Priya/i);
    t.judge.autoevals
      .closedQA(
        "The reply states that Priya owns the deploy token rotation, grounded in " +
          "what was previously saved to memory rather than guessed.",
        { on: second.message },
      )
      .atLeast(0.5);

    t.didNotFail();
    t.completed();
  },
});
