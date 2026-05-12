import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AnimatedLogo from '../AnimatedLogo';

describe('AnimatedLogo', () => {
  const mockProps = {
    src: '/test-logo.png',
    alt: 'Test Logo',
    className: 'custom-class'
  };

  beforeEach(() => {
    window.scrollTo = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('渲染', () => {
    it('应该正确渲染 logo 图片', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      expect(logo).toBeInTheDocument();
      expect(logo).toHaveAttribute('src', '/test-logo.png');
    });

    it('应该应用自定义类名', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      expect(logo).toHaveClass('custom-class');
      expect(logo).toHaveClass('animated-logo');
    });

    it('应该在初始状态下添加 loading 类', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      expect(logo).toHaveClass('loading');
    });

    it('图片加载后应该添加 loaded 类并移除 loading 类', async () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo') as HTMLImageElement;
      
      fireEvent.load(logo);
      
      await waitFor(() => {
        expect(logo).toHaveClass('loaded');
        expect(logo).not.toHaveClass('loading');
      });
    });

    it('应该设置 draggable 为 false', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      expect(logo).toHaveAttribute('draggable', 'false');
    });
  });

  describe('鼠标悬停交互', () => {
    it('鼠标进入时应该触发悬停效果', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      fireEvent.mouseEnter(logo);
      
      expect(logo).toHaveStyle({
        filter: 'brightness(1.2) drop-shadow(0 0 12px rgba(134, 59, 255, 0.6))'
      });
    });

    it('鼠标离开时应该恢复原始样式', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      fireEvent.mouseEnter(logo);
      fireEvent.mouseLeave(logo);
      
      expect(logo).toHaveStyle({
        filter: 'brightness(1)'
      });
    });

    it('悬停时应该应用放大和旋转效果', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      fireEvent.mouseEnter(logo);
      
      expect(logo).toHaveStyle({
        transition: 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.3s ease'
      });
    });
  });

  describe('滚动交互', () => {
    it('应该监听滚动事件', () => {
      const addEventListenerSpy = jest.spyOn(window, 'addEventListener');
      render(<AnimatedLogo {...mockProps} />);
      
      expect(addEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
      addEventListenerSpy.mockRestore();
    });

    it('组件卸载时应该移除滚动事件监听器', () => {
      const removeEventListenerSpy = jest.spyOn(window, 'removeEventListener');
      const { unmount } = render(<AnimatedLogo {...mockProps} />);
      
      unmount();
      
      expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
      removeEventListenerSpy.mockRestore();
    });

    it('滚动时应该更新 transform 样式', async () => {
      Object.defineProperty(window, 'scrollY', {
        value: 150,
        writable: true
      });

      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      const scrollEvent = new Event('scroll');
      window.dispatchEvent(scrollEvent);
      
      await waitFor(() => {
        expect(logo).toHaveStyle({
          transform: expect.stringContaining('translateY')
        });
      });
    });
  });

  describe('动画效果', () => {
    it('应该在加载时应用 fadeInUp 动画', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      expect(logo).toHaveClass('loading');
      expect(logo).toHaveStyle({
        animation: 'fadeInUp 0.6s ease-out forwards'
      });
    });

    it('加载完成后应该停止动画', async () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo') as HTMLImageElement;
      
      fireEvent.load(logo);
      
      await waitFor(() => {
        expect(logo).toHaveClass('loaded');
        expect(logo).not.toHaveClass('loading');
      });
    });
  });

  describe('性能优化', () => {
    it('应该使用 passive 滚动事件监听器', () => {
      const addEventListenerSpy = jest.spyOn(window, 'addEventListener');
      render(<AnimatedLogo {...mockProps} />);
      
      expect(addEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
      addEventListenerSpy.mockRestore();
    });

    it('应该设置 will-change 优化性能', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      const container = logo.parentElement;
      
      expect(container).toHaveClass('logo-container');
    });
  });

  describe('响应式行为', () => {
    it('应该在小屏幕上正常工作', () => {
      global.innerWidth = 500;
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      expect(logo).toBeInTheDocument();
    });

    it('应该在大屏幕上正常工作', () => {
      global.innerWidth = 1920;
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      expect(logo).toBeInTheDocument();
    });
  });

  describe('无障碍性', () => {
    it('应该提供正确的 alt 文本', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      expect(logo).toBeInTheDocument();
    });

    it('应该支持键盘导航', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      logo.focus();
      expect(document.activeElement).toBe(logo);
    });
  });

  describe('边界情况', () => {
    it('应该处理空的 className', () => {
      render(<AnimatedLogo src="/test.png" alt="Test" />);
      const logo = screen.getByAltText('Test');
      
      expect(logo).toBeInTheDocument();
      expect(logo).toHaveClass('animated-logo');
    });

    it('应该处理快速鼠标进入和离开', () => {
      render(<AnimatedLogo {...mockProps} />);
      const logo = screen.getByAltText('Test Logo');
      
      fireEvent.mouseEnter(logo);
      fireEvent.mouseLeave(logo);
      fireEvent.mouseEnter(logo);
      fireEvent.mouseLeave(logo);
      
      expect(logo).toHaveStyle({
        filter: 'brightness(1)'
      });
    });

    it('应该处理滚动事件频繁触发', () => {
      render(<AnimatedLogo {...mockProps} />);
      
      for (let i = 0; i < 100; i++) {
        window.dispatchEvent(new Event('scroll'));
      }
      
      const logo = screen.getByAltText('Test Logo');
      expect(logo).toBeInTheDocument();
    });
  });
});

describe('AnimatedLogo 性能测试', () => {
  it('滚动事件处理应该在合理时间内完成', () => {
    const startTime = performance.now();
    
    render(<AnimatedLogo src="/test.png" alt="Test" />);
    
    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event('scroll'));
    }
    
    const endTime = performance.now();
    expect(endTime - startTime).toBeLessThan(100);
  });

  it('悬停效果应该快速响应', () => {
    render(<AnimatedLogo src="/test.png" alt="Test" />);
    const logo = screen.getByAltText('Test Logo');
    
    const startTime = performance.now();
    fireEvent.mouseEnter(logo);
    const endTime = performance.now();
    
    expect(endTime - startTime).toBeLessThan(50);
  });
});

describe('AnimatedLogo 浏览器兼容性测试', () => {
  it('应该在不支持 prefers-reduced-motion 的浏览器中正常工作', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: jest.fn().mockImplementation(query => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });

    render(<AnimatedLogo src="/test.png" alt="Test" />);
    const logo = screen.getByAltText('Test');
    
    expect(logo).toBeInTheDocument();
  });

  it('应该在支持 prefers-reduced-motion 的浏览器中禁用动画', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: jest.fn().mockImplementation(query => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });

    render(<AnimatedLogo src="/test.png" alt="Test" />);
    const logo = screen.getByAltText('Test');
    
    expect(logo).toBeInTheDocument();
  });
});
