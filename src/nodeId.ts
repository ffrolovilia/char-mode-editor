// Suggests the next node id by finding the highest numeric suffix among
// existing ids (e.g. "N0", "N1", "N5" -> "N6"). Falls back to "N0" when the
// graph has no numbered nodes.
const NODE_ID_PATTERN = /^([A-Za-z]*)(\d+)$/;

export function nextNodeId(nodeIds: string[]): string {
  let maxIndex = -1;
  let prefix = "N";
  for (const id of nodeIds) {
    const match = NODE_ID_PATTERN.exec(id.trim());
    if (!match) continue;
    const index = Number.parseInt(match[2], 10);
    if (index > maxIndex) {
      maxIndex = index;
      prefix = match[1] || "N";
    }
  }
  return `${prefix}${maxIndex + 1}`;
}
