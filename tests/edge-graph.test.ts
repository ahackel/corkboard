// An older board's junctions become plain card-to-card lines, and nothing else changes.
import { describe, expect, it } from 'vitest';
import { flattenJunctions, type GraphEdge } from '../src/utils/edge-graph.js';

const edge = (id: string, from: string, to: string, extra: Partial<GraphEdge> = {}): GraphEdge =>
  ({ id, from, to, color: '', dashed: false, fromCap: 'none', toCap: 'arrow', label: '', ...extra });
const isJ = (id: string) => id.startsWith('j');
const pairs = (es: GraphEdge[]) => es.map(e => `${e.from}->${e.to}`).sort();

describe('flattenJunctions', () => {
  it('leaves card-to-card lines alone', () => {
    const es = [edge('e1', 'A', 'B')];
    expect(flattenJunctions(es, isJ)).toEqual(es);
  });
  it('turns a three-way junction into a star from the first card', () => {
    const out = flattenJunctions([edge('e1', 'A', 'j1'), edge('e2', 'j1', 'B'), edge('e3', 'j1', 'C', { color: 'red' })], isJ);
    expect(pairs(out)).toEqual(['A->B', 'A->C']);
    expect(out.find(e => e.to === 'C')!.color).toBe('red');   // a line keeps the style it came in by
  });
  it('treats junctions joined by a line as one meeting point', () => {
    const out = flattenJunctions([edge('e1', 'A', 'j1'), edge('e2', 'j1', 'j2'), edge('e3', 'j2', 'B')], isJ);
    expect(pairs(out)).toEqual(['A->B']);
  });
  it('keeps the caps at the card ends', () => {
    const out = flattenJunctions([edge('e1', 'A', 'j1', { fromCap: 'dot' }), edge('e2', 'j1', 'B', { toCap: 'arrow' })], isJ);
    expect(out).toMatchObject([{ from: 'A', to: 'B', fromCap: 'dot', toCap: 'arrow' }]);
  });
  it('drops a junction only one card reaches', () => {
    expect(flattenJunctions([edge('e1', 'A', 'j1')], isJ)).toEqual([]);
  });
});
