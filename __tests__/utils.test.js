/**
 * P0-4: Test Coverage - utils.js Tests
 */

const {
  formatSlugToDisplayName,
  formatTime,
  getWindowSizeForAgents
} = require('../src/utils');

describe('formatSlugToDisplayName', () => {
  test('converts slug to title case', () => {
    expect(formatSlugToDisplayName('toasty-sparking-lecun'))
      .toBe('Toasty Sparking Lecun');
  });

  test('handles empty input', () => {
    expect(formatSlugToDisplayName(null)).toBe('Agent');
    expect(formatSlugToDisplayName(undefined)).toBe('Agent');
    expect(formatSlugToDisplayName('')).toBe('Agent');
  });

  test('handles single word', () => {
    expect(formatSlugToDisplayName('claude')).toBe('Claude');
  });

  test('handles multiple hyphens', () => {
    expect(formatSlugToDisplayName('agent-one-two-three'))
      .toBe('Agent One Two Three');
  });
});

describe('formatTime', () => {
  test('formats milliseconds to MM:SS', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(1000)).toBe('00:01');
    expect(formatTime(5000)).toBe('00:05');
    expect(formatTime(60000)).toBe('01:00');
    expect(formatTime(65000)).toBe('01:05');
    expect(formatTime(3600000)).toBe('60:00');
  });

  test('handles edge cases', () => {
    expect(formatTime(999)).toBe('00:00');
    expect(formatTime(1001)).toBe('00:01');
    expect(formatTime(59999)).toBe('00:59');
    expect(formatTime(60001)).toBe('01:00');
  });

  test('handles large values', () => {
    expect(formatTime(3599000)).toBe('59:59');
    expect(formatTime(3600000)).toBe('60:00');
    expect(formatTime(7200000)).toBe('120:00');
  });
});

describe('getWindowSizeForAgents', () => {
  test('returns minimum size for 0 or 1 agent', () => {
    expect(getWindowSizeForAgents(0)).toEqual({ width: 150, height: 150 });
    expect(getWindowSizeForAgents(1)).toEqual({ width: 150, height: 150 });
  });

  test('calculates size for multiple agents (count only)', () => {
    const size2 = getWindowSizeForAgents(2);
    expect(size2.width).toBeGreaterThan(150);
    expect(size2.height).toBe(170);

    const size10 = getWindowSizeForAgents(10);
    expect(size10.width).toBeGreaterThan(150);
    expect(size10.height).toBe(170);
  });

  test('calculates size for agent array with project groups', () => {
    const agents = [
      { id: '1', projectPath: '/project1', isSubagent: false, isTeammate: false },
      { id: '2', projectPath: '/project1', isSubagent: true, isTeammate: false },
      { id: '3', projectPath: '/project2', isSubagent: false, isTeammate: false }
    ];

    const size = getWindowSizeForAgents(agents);
    expect(size.width).toBeGreaterThan(150);
    expect(size.height).toBeGreaterThanOrEqual(170);
  });

  test('handles team agents (subagents/teammates)', () => {
    // Satellite layout: subagents with parentId are embedded in parent card,
    // so they don't add grid columns but parent gets extra height
    const teamAgents = Array.from({ length: 5 }, (_, i) => ({
      id: `agent-${i}`,
      projectPath: '/project1',
      isSubagent: i > 0,
      isTeammate: false,
      parentId: i > 0 ? 'agent-0' : null
    }));

    const size = getWindowSizeForAgents(teamAgents);
    expect(size.width).toBeGreaterThan(150);
    // Parent with satellites gets extra height (SATELLITE_EXTRA_H = 40)
    expect(size.height).toBeGreaterThan(170);
  });

  test('handles solo agents', () => {
    const soloAgents = Array.from({ length: 3 }, (_, i) => ({
      id: `agent-${i}`,
      projectPath: `/project${i}`,
      isSubagent: false,
      isTeammate: false
    }));

    const size = getWindowSizeForAgents(soloAgents);
    expect(size.width).toBeGreaterThan(150);
    expect(size.height).toBe(170);
  });

  test('respects max column limit of 10', () => {
    const manyAgents = Array.from({ length: 15 }, (_, i) => ({
      id: `agent-${i}`,
      projectPath: '/project1',
      isSubagent: false,
      isTeammate: false
    }));

    const size = getWindowSizeForAgents(manyAgents);
    // Width should not exceed what 10 columns would allow
    expect(size.width).toBeLessThanOrEqual(1000);
  });
});
