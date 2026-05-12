import { ArcLayer } from '@deck.gl/layers';

export default class AnimatedArcLayer extends ArcLayer {
  constructor(props: any) {
    super(props);
  }

  getShaders() {
    const shaders = super.getShaders();
    
    return {
      ...shaders,
      inject: {
        'fs:defs': `
          uniform float time;
        `,
        'fs:main': `
          // 计算光线流动效果
          float normalizedTime = fract(time * 0.5); // 控制动画速度
          float uvX = geometry.uv.x;
          
          // 创建一个移动的高光窗口
          float lightPosition = normalizedTime;
          float lightWidth = 0.1;
          float lightFalloff = 0.05;
          
          // 计算当前像素在光线上的相对位置
          float distanceToLight = abs(uvX - lightPosition);
          
          // 生成 alpha 遮罩，模拟光子流动效果
          float alpha = 1.0;
          if (distanceToLight < lightWidth) {
            // 光线中心区域
            alpha = 1.0;
          } else if (distanceToLight < lightWidth + lightFalloff) {
            // 光线边缘的渐变
            alpha = 1.0 - (distanceToLight - lightWidth) / lightFalloff;
          } else {
            // 光线外的区域
            alpha = 0.2;
          }
          
          // 应用 alpha 遮罩
          outgoingColor.a *= alpha;
        `
      }
    };
  }

  updateState(params: any) {
    super.updateState(params);
    
    const { time } = this.props as any;
    if (time !== undefined && (this.state as any).model) {
      (this.state as any).model.setUniforms({ time });
    }
  }

  draw(params: any) {
    const { time } = this.props as any;
    if (time !== undefined && (this.state as any).model) {
      (this.state as any).model.setUniforms({ time });
    }
    super.draw(params);
  }
}
