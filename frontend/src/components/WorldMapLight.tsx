import React, { useMemo } from 'react';
import { useXClawStore } from '../store/useXClawStore';
import worldOutline from '../assets/world-outline.json';
import { useI18n } from '../i18n/LanguageContext';

const W = 720;
const H = 360;

function proj(lng: number, lat: number): [number, number] {
  return [((lng + 180) / 360) * W, ((90 - lat) / 180) * H];
}

interface Outline {
  type: string;
  coordinates: number[][][][];
}

/**
 * 轻量 SVG 世界地图：内置轮廓（27KB，无外部瓦片依赖），
 * 首屏不加载 maplibre/deck.gl，大幅提升弱网络下的打开速度。
 */
export default function WorldMapLight() {
  const { t } = useI18n();
  const agents = useXClawStore(s => s.agents);

  const paths = useMemo(() => {
    const polys = (worldOutline as Outline).coordinates;
    return polys.map((poly, i) => {
      const d = poly.map(ring => {
        const inner = ring.map(([x, y], j) => {
          const [px, py] = proj(x, y);
          return `${j === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
        }).join(' ');
        return `${inner} Z`;
      }).join(' ');
      return <path key={i} d={d} fill="#1E293B" stroke="#0B0F19" strokeWidth="0.4" />;
    });
  }, []);

  return (
    <div className="w-full h-full bg-[#0B0F19] relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="w-full h-full block">
        {paths}
        {agents.map(a => {
          const [x, y] = proj(a.lng, a.lat);
          return (
            <g key={a.id}>
              <circle
                cx={x}
                cy={y}
                r={a.online ? 4 : 3}
                fill={a.online ? '#22d3ee' : '#64748b'}
                opacity={a.online ? 0.9 : 0.45}
              >
                <title>{`${a.name} · ${a.online ? t('wsLive') : t('wsOffline')}`}</title>
              </circle>
              {a.online && (
                <circle cx={x} cy={y} r={7} fill="none" stroke="#22d3ee" strokeWidth="0.6" opacity={0.35} />
              )}
            </g>
          );
        })}
      </svg>
      <div className="absolute bottom-2 left-2 text-[10px] text-slate-500 font-mono pointer-events-none">
        {agents.filter(a => a.online).length} / {agents.length} {t('agentsOnline')}
      </div>
    </div>
  );
}
