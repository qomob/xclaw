import React, { useCallback, useState } from 'react';

export interface GalaxyFilter {
  capabilities: string[];
  onlineOnly: boolean;
  minReputation: number;
}

export type TimeRange = 'live' | '24h' | '7d' | '30d';
export type LayoutMode = 'force' | 'sphere' | 'hierarchy';
export type ViewPreset = 'top' | 'side' | 'free';

export interface GalaxyControlsProps {
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  layout: LayoutMode;
  onLayoutChange: (layout: LayoutMode) => void;
  filter: GalaxyFilter;
  onFilterChange: (filter: GalaxyFilter) => void;
  onViewPreset: (preset: ViewPreset) => void;
  onSearch: (query: string) => void;
}

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
];

const LAYOUT_MODES: { value: LayoutMode; label: string }[] = [
  { value: 'sphere', label: 'Sphere' },
  { value: 'force', label: 'Force' },
  { value: 'hierarchy', label: 'Hierarchy' },
];

const CAPABILITY_OPTIONS = [
  'search',
  'creative',
  'analysis',
  'communication',
  'infrastructure',
];

const GalaxyControls: React.FC<GalaxyControlsProps> = ({
  timeRange,
  onTimeRangeChange,
  layout,
  onLayoutChange,
  filter,
  onFilterChange,
  onViewPreset,
  onSearch,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [expanded, setExpanded] = useState(true);

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      onSearch(searchQuery);
    },
    [searchQuery, onSearch]
  );

  const toggleCapability = useCallback(
    (cap: string) => {
      const has = filter.capabilities.includes(cap);
      onFilterChange({
        ...filter,
        capabilities: has
          ? filter.capabilities.filter((c) => c !== cap)
          : [...filter.capabilities, cap],
      });
    },
    [filter, onFilterChange]
  );

  return (
    <div
      className="absolute top-3 left-3 z-20 flex flex-col gap-2 select-none"
      style={{ maxWidth: 260 }}
    >
      {/* Toggle button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="self-start px-2 py-1 text-xs rounded bg-black/70 text-cyan-400 border border-cyan-800 hover:bg-black/90 transition"
      >
        {expanded ? '◀ Collapse' : '▶ Controls'}
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 p-3 rounded-lg bg-black/80 border border-cyan-900/60 text-white text-xs">
          {/* Search */}
          <form onSubmit={handleSearch} className="flex gap-1">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search agent..."
              className="flex-1 px-2 py-1 rounded bg-gray-900 border border-gray-700 text-xs text-white placeholder-gray-500 focus:border-cyan-600 focus:outline-none"
            />
            <button
              type="submit"
              className="px-2 py-1 rounded bg-cyan-800 hover:bg-cyan-700 transition text-xs"
            >
              🔍
            </button>
          </form>

          {/* Time range */}
          <div>
            <div className="text-gray-400 mb-1">Time Range</div>
            <div className="flex gap-1">
              {TIME_RANGES.map((tr) => (
                <button
                  key={tr.value}
                  onClick={() => onTimeRangeChange(tr.value)}
                  className={`px-2 py-0.5 rounded text-xs transition ${
                    timeRange === tr.value
                      ? 'bg-cyan-700 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {tr.label}
                </button>
              ))}
            </div>
          </div>

          {/* View presets */}
          <div>
            <div className="text-gray-400 mb-1">View Presets</div>
            <div className="flex gap-1">
              <button
                onClick={() => onViewPreset('top')}
                className="px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 text-xs"
              >
                Top
              </button>
              <button
                onClick={() => onViewPreset('side')}
                className="px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 text-xs"
              >
                Side
              </button>
              <button
                onClick={() => onViewPreset('free')}
                className="px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 text-xs"
              >
                Free
              </button>
            </div>
          </div>

          {/* Layout */}
          <div>
            <div className="text-gray-400 mb-1">Layout Algorithm</div>
            <div className="flex gap-1">
              {LAYOUT_MODES.map((lm) => (
                <button
                  key={lm.value}
                  onClick={() => onLayoutChange(lm.value)}
                  className={`px-2 py-0.5 rounded text-xs transition ${
                    layout === lm.value
                      ? 'bg-purple-700 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {lm.label}
                </button>
              ))}
            </div>
          </div>

          {/* Capabilities filter */}
          <div>
            <div className="text-gray-400 mb-1">Capability Filter</div>
            <div className="flex flex-wrap gap-1">
              {CAPABILITY_OPTIONS.map((cap) => (
                <button
                  key={cap}
                  onClick={() => toggleCapability(cap)}
                  className={`px-1.5 py-0.5 rounded text-xs capitalize transition ${
                    filter.capabilities.includes(cap)
                      ? 'bg-cyan-700 text-white'
                      : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                  }`}
                >
                  {cap}
                </button>
              ))}
            </div>
          </div>

          {/* Online only */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filter.onlineOnly}
              onChange={(e) =>
                onFilterChange({ ...filter, onlineOnly: e.target.checked })
              }
              className="accent-cyan-600"
            />
            <span className="text-gray-400">Online Only</span>
          </label>

          {/* Reputation slider */}
          <div>
            <div className="text-gray-400 mb-1">
              Min Reputation: {filter.minReputation}
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={filter.minReputation}
              onChange={(e) =>
                onFilterChange({
                  ...filter,
                  minReputation: Number(e.target.value),
                })
              }
              className="w-full accent-cyan-600"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default GalaxyControls;
