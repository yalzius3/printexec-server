export function buildUpdateClause(
  updates: Record<string, unknown>,
  startingIndex = 1
) {
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);

  if (entries.length === 0) {
    return {
      clause: "",
      values: [] as unknown[]
    };
  }

  const assignments = entries.map(
    ([column], index) => `${column} = $${index + startingIndex}`
  );

  return {
    clause: assignments.join(", "),
    values: entries.map(([, value]) => value)
  };
}
