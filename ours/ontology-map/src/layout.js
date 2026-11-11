/**
 * Deterministic force layout for the data map, with no harness or browser
 * dependencies. The same entities and links always give the same positions,
 * so the map does not rearrange itself between visits.
 *
 * Positions are in an abstract plane centred on (0, 0); the browser fits the
 * bounding box to its viewport. `spacing` is the preferred link length.
 */

/**
 * @param {Array<{id: string, score?: number}>} nodes - drawing order; the first node starts at the centre.
 * @param {Array<{source: string, target: string}>} links - links whose ends are not in `nodes` are ignored.
 * @param {{iterations?: number, spacing?: number}} [options]
 * @returns {Record<string, [number, number]>} rounded positions by node id.
 */
export function forceLayout(nodes, links, { iterations = 400, spacing = 120 } = {}) {
  const n = nodes.length
  if (n === 0) return {}
  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const edges = []
  for (const link of links) {
    const a = index.get(link.source)
    const b = index.get(link.target)
    if (a !== undefined && b !== undefined && a !== b) edges.push([a, b])
  }
  // Start on a sunflower spiral so the most connected nodes (first) sit in the middle.
  const golden = Math.PI * (3 - Math.sqrt(5))
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const r = spacing * 0.6 * Math.sqrt(i + 0.5)
    x[i] = r * Math.cos(i * golden)
    y[i] = r * Math.sin(i * golden)
  }
  const k = spacing
  const minGap = spacing * 0.55
  let temperature = spacing * 1.5
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  for (let step = 0; step < iterations; step++) {
    dx.fill(0); dy.fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = x[i] - x[j]
        let ey = y[i] - y[j]
        let d2 = ex * ex + ey * ey
        if (d2 < 1e-6) { ex = 0.01 * (i - j); ey = 0.01; d2 = ex * ex + ey * ey }
        const d = Math.sqrt(d2)
        let force = (k * k) / d
        if (d < minGap) force += (minGap - d) * 4
        const fx = (ex / d) * force
        const fy = (ey / d) * force
        dx[i] += fx; dy[i] += fy; dx[j] -= fx; dy[j] -= fy
      }
    }
    for (const [a, b] of edges) {
      const ex = x[a] - x[b]
      const ey = y[a] - y[b]
      const d = Math.max(Math.sqrt(ex * ex + ey * ey), 1e-3)
      const force = (d * d) / k
      const fx = (ex / d) * force
      const fy = (ey / d) * force
      dx[a] -= fx; dy[a] -= fy; dx[b] += fx; dy[b] += fy
    }
    for (let i = 0; i < n; i++) {
      // Gravity keeps nodes without links near the rest.
      dx[i] -= x[i] * 0.08
      dy[i] -= y[i] * 0.08
      const length = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i])
      if (length > 0) {
        const limited = Math.min(length, temperature)
        x[i] += (dx[i] / length) * limited
        y[i] += (dy[i] / length) * limited
      }
    }
    temperature = Math.max(temperature * 0.985, 0.5)
  }
  const positions = {}
  for (let i = 0; i < n; i++) positions[nodes[i].id] = [Math.round(x[i]), Math.round(y[i])]
  return positions
}
