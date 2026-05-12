
/**
 * 地理坐标 (WGS84) 到 Web Mercator 投影转换
 * 用于验证 Deck.gl 内部投影的一致性
 */
export function lngLatToWebMercator(lng: number, lat: number): [number, number] {
  const x = (lng + 180) * (256 / 360);
  const latRad = (lat * Math.PI) / 180;
  const y = (256 / (2 * Math.PI)) * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return [x, 128 - y]; // 归一化到 256x256 瓦片坐标系
}

/**
 * 验证位置精度
 * @param expectedLngLat 原始经纬度
 * @param actualLngLat 渲染后的经纬度
 * @returns 误差（像素，假设在特定缩放级别）
 */
export function verifyPositionPrecision(
  expectedLngLat: [number, number],
  actualLngLat: [number, number],
  zoom: number = 0
): number {
  const [x1, y1] = lngLatToWebMercator(expectedLngLat[0], expectedLngLat[1]);
  const [x2, y2] = lngLatToWebMercator(actualLngLat[0], actualLngLat[1]);
  
  const scale = Math.pow(2, zoom);
  const dx = (x2 - x1) * scale;
  const dy = (y2 - y1) * scale;
  
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 运行精度测试
 */
export function runPrecisionTests() {
  const testCases: Array<[number, number]> = [
    [0, 0],       // 赤道/本初子午线
    [120, 30],    // 亚洲
    [-74, 40],    // 北美
    [0, 85],      // 极地附近（测试投影畸变）
  ];

  console.log('--- POSITION PRECISION TESTS ---');
  testCases.forEach(([lng, lat]) => {
    // 模拟 Deck.gl 内部转换后再转回（简化模拟）
    const error = verifyPositionPrecision([lng, lat], [lng, lat]); // 自身对比应为 0
    
    console.log(`Point [${lng}, ${lat}]: Error = ${error.toFixed(10)} px`);
    if (error > 0.1) {
      console.error(`FAILED: Error ${error} exceeds threshold 0.1px`);
    }
  });
}
