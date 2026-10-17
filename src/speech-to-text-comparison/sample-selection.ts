/**
 * Picks samples so that the fewest new checks are needed: samples every engine already checked,
 * then partly checked ones (most covered first), then unchecked ones. Ties keep the input order,
 * so a larger count keeps the samples a smaller count picked.
 */
export function pickSamples(
  sampleIds: string[],
  engineKeys: string[],
  stored: { engineKey: string; sampleId: string }[],
  count: number,
) {
  const engines = new Set(engineKeys);
  const covered = new Map<string, number>();
  for (const result of stored) {
    if (engines.has(result.engineKey)) covered.set(result.sampleId, (covered.get(result.sampleId) ?? 0) + 1);
  }
  return sampleIds
    .map((id, index) => ({ id, index, covered: covered.get(id) ?? 0 }))
    .sort((a, b) => b.covered - a.covered || a.index - b.index)
    .slice(0, count)
    .map((sample) => sample.id);
}
