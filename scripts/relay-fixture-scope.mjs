// Direct library fixtures must name their Goal, just like production entry points.
// This map contains only identities explicitly registered by each fixture.
export function createRelayFixtureScope(withRelayGoal) {
  const goals = new Map();
  return {
    set(workspace, goalId) {
      if (!workspace || !goalId) throw new Error("Fixture Goal identity is required");
      goals.set(workspace, goalId);
    },
    wrap(module) {
      return new Proxy(module, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args) => {
            const goalId = goals.get(args[0]);
            return goalId ? withRelayGoal(args[0], goalId, () => value(...args)) : value(...args);
          };
        },
      });
    },
  };
}
