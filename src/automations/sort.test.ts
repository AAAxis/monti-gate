import {describe, expect, it} from 'vitest';
import {sortAutomations} from './sort';
import type {ScoutAutomation} from '../types';

function automation(id: string, createdAt?: string): ScoutAutomation {
  return {id, name: id, steps: [], created_at: createdAt};
}

describe('sortAutomations', () => {
  it('puts starred first, newest first within each group', () => {
    const list = [
      automation('old', '2026-01-01T00:00:00Z'),
      automation('new', '2026-03-01T00:00:00Z'),
      automation('starred-old', '2025-06-01T00:00:00Z'),
      automation('mid', '2026-02-01T00:00:00Z'),
    ];
    const sorted = sortAutomations(list, ['starred-old']);
    expect(sorted.map((a) => a.id)).toEqual(['starred-old', 'new', 'mid', 'old']);
  });

  it('orders two starred automations newest first', () => {
    const list = [
      automation('a', '2026-01-01T00:00:00Z'),
      automation('b', '2026-02-01T00:00:00Z'),
    ];
    const sorted = sortAutomations(list, ['a', 'b']);
    expect(sorted.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('breaks created_at ties on id so the order is stable', () => {
    const list = [
      automation('bbb', '2026-01-01T00:00:00Z'),
      automation('aaa', '2026-01-01T00:00:00Z'),
    ];
    expect(sortAutomations(list, []).map((entry) => entry.id)).toEqual(['aaa', 'bbb']);
    expect(sortAutomations([...list].reverse(), []).map((entry) => entry.id))
        .toEqual(['aaa', 'bbb']);
  });

  it('sorts a row with no created_at last', () => {
    const list = [automation('undated'), automation('dated', '2026-01-01T00:00:00Z')];
    expect(sortAutomations(list, []).map((entry) => entry.id)).toEqual(['dated', 'undated']);
  });

  it('does not mutate its input', () => {
    const list = [
      automation('b', '2026-02-01T00:00:00Z'),
      automation('a', '2026-01-01T00:00:00Z'),
    ];
    const before = [...list];
    sortAutomations(list, ['a']);
    expect(list).toEqual(before);
  });
});
