"use client";

import { useEffect, useState, type ComponentType } from "react";

type LoadedSplineComponent = ComponentType<{
  scene: string;
  className?: string;
  onLoad?: () => void;
  onError?: () => void;
}>;

interface SplineSceneProps {
  scene: string;
  className?: string;
  fallbackSrc?: string;
}

export function SplineScene({ scene, className, fallbackSrc }: SplineSceneProps) {
  const [Spline, setSpline] = useState<LoadedSplineComponent | null>(null);
  const [sceneLoaded, setSceneLoaded] = useState(false);
  const [showFallbackOnly, setShowFallbackOnly] = useState(false);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      if (active && !sceneLoaded) {
        setShowFallbackOnly(true);
      }
    }, 4500);

    import("@splinetool/react-spline")
      .then((mod) => {
        if (active) {
          setSpline(() => mod.default as LoadedSplineComponent);
        }
      })
      .catch(() => {
        if (active) {
          setShowFallbackOnly(true);
        }
      });

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [sceneLoaded]);

  if (!Spline || showFallbackOnly) {
    return <SplineFallback fallbackSrc={fallbackSrc} />;
  }

  return (
    <Spline
      scene={scene}
      className={className}
      onLoad={() => setSceneLoaded(true)}
      onError={() => setShowFallbackOnly(true)}
    />
  );
}

function SplineFallback({ fallbackSrc }: { fallbackSrc?: string }) {
  return (
    <div className="spline-fallback" aria-label="AI security robot visual">
      {fallbackSrc ? (
        <img src={fallbackSrc} alt="" width="560" height="840" decoding="async" fetchPriority="high" />
      ) : (
        <div className="spline-fallback-badge">AI</div>
      )}
      <span>AI Security Gateway</span>
    </div>
  );
}
