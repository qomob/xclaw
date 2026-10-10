import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import { setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { MapLibreOverlay } from '@deck.gl/maplibre';
import type { DeckProps, Layer, PickingInfo } from '@deck.gl/core';

// maplibre v6 把矢量瓦片的解析全部放在 Web Worker 里；worker 地址在库内部用
// `new URL('./' + name, import.meta.url)` 动态拼接，vite 无法静态分析，
// dev 与 build 都会 404（worker 起不来 = 矢量管线全灭，只剩背景色）。
// 官方文档要求 bundler 环境必须显式配置 worker 地址。
setWorkerUrl(maplibreWorkerUrl);

// CARTO 深色底图：deck.gl 9.4 的 MapLibreOverlay 是官方支持 maplibre-gl v6 的集成方式。
// 不要改回 <DeckGL><StaticMap/></DeckGL> children 模式——react-maplibre 的相机同步
// 与 v6 的 transform 管线不兼容（相机死循环导致瓦片永远加载不出来）。
export const CARTO_DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export interface MaplibreDeckOptions {
  center: [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
  layers: Layer[];
  getTooltip?: DeckProps['getTooltip'];
  onMapReady?: (map: maplibregl.Map) => void;
}

export function useMaplibreDeck(options: MaplibreDeckOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { center, zoom, pitch, bearing } = latest.current;
    const map = new maplibregl.Map({
      container,
      style: CARTO_DARK_STYLE,
      center,
      zoom,
      pitch: pitch ?? 0,
      bearing: bearing ?? 0,
    });
    mapRef.current = map;
    map.on('load', () => {
      // load 前的图层更新都记录在 latest 里，这里带上最新值创建 overlay
      const overlay = new MapLibreOverlay({
        layers: latest.current.layers,
        getTooltip: latest.current.getTooltip,
        useDevicePixels: false,
      });
      overlayRef.current = overlay;
      map.addControl(overlay as unknown as maplibregl.IControl);
      latest.current.onMapReady?.(map);
    });
    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
    // 仅在挂载时创建一次地图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    overlayRef.current?.setProps({ layers: options.layers, getTooltip: options.getTooltip });
  }, [options.layers, options.getTooltip]);

  return { containerRef, mapRef };
}

export type { PickingInfo };
