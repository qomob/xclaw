import React, { useState, useEffect, useRef } from 'react';

interface AnimatedLogoProps {
  src: string;
  alt: string;
  className?: string;
}

export default function AnimatedLogo({ src, alt, className = '' }: AnimatedLogoProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const logoRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const handleScroll = () => {
      const scrollY = window.scrollY;
      const maxScroll = 300;
      const progress = Math.min(scrollY / maxScroll, 1);
      setScrollProgress(progress);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleImageLoad = () => {
    setIsLoaded(true);
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
  };

  const animationStyles: React.CSSProperties = {
    transform: `
      translateY(${scrollProgress * -2}px) 
      scale(${1 + scrollProgress * 0.05})
      ${isHovered ? 'scale(1.1) rotate(5deg)' : ''}
    `,
    filter: isHovered ? 'brightness(1.2) drop-shadow(0 0 12px rgba(134, 59, 255, 0.6))' : 'brightness(1)',
    transition: isHovered 
      ? 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.3s ease'
      : 'transform 0.1s ease-out, filter 0.3s ease',
    opacity: isLoaded ? 1 : 0,
    animation: isLoaded ? 'none' : 'fadeInUp 0.6s ease-out forwards'
  };

  return (
    <div className="logo-container">
      <img
        ref={logoRef}
        src={src}
        alt={alt}
        className={`animated-logo ${isLoaded ? 'loaded' : 'loading'} ${className}`}
        style={animationStyles}
        onLoad={handleImageLoad}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        draggable={false}
      />
      <div className="logo-glow-effect" />
    </div>
  );
}
