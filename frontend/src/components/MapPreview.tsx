import React, { useMemo } from 'react';
import { useXClawStore } from '../store/useXClawStore';
import { useI18n } from '../i18n/LanguageContext';

const W = 720;
const H = 360;

function proj(lng: number, lat: number): [number, number] {
  return [((lng + 180) / 360) * W, ((90 - lat) / 180) * H];
}

/**
 * 3D 地图加载占位：零依赖、即时渲染。
 * Agent 节点按经纬度就位（与真实地图同一数据源），完整 3D 地图后台加载后无缝替换。
 */
export default function MapPreview() {
  const { t } = useI18n();
  const agents = useXClawStore(s => s.agents);

  const dots = useMemo(
    () => agents.map(a => ({ ...a, x: proj(a.lng, a.lat)[0], y: proj(a.lng, a.lat)[1] })),
    [agents]
  );

  return (
    <div className="w-full h-full bg-[#0B0F19] relative overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          opacity: 0.22,
          backgroundImage:
            'linear-gradient(rgba(34,211,238,.14) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,.14) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="w-full h-full relative block">
        {dots.map(d => (
          <g key={d.id}>
            <circle
              cx={d.x}
              cy={d.y}
              r={d.online ? 4 : 3}
              fill={d.online ? '#22d3ee' : '#64748b'}
              opacity={d.online ? 0.9 : 0.5}
            />
            {d.online && (
              <circle cx={d.x} cy={d.y} r={8} fill="none" stroke="#22d3ee" strokeWidth="0.6" opacity={0.35} />
            )}
          </g>
        ))}
      </svg>
      <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between pointer-events-none">
        <span className="text-[10px] text-slate-500 font-mono">
          {agents.filter(a => a.online).length}/{agents.length} {t('agentsOnline')}
        </span>
        <span className="text-[10px] text-cyan-400/80 font-mono flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
          {t('loading')} 3D…
        </span>
      </div>
    </div>
  );
}
