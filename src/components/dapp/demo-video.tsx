"use client";

import { useEffect, useRef } from "react";

/**
 * The node-setup demo. Starts playing (muted) the first time it is on screen, so a visitor who
 * arrives from Launch App sees it move; after that the visitor controls it. Reduced motion: never autoplays.
 */
export function DemoVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let started = false;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (started || !entry.isIntersecting) return;
        started = true;
        video.play().catch(() => {
          /* autoplay refused: the poster and the play button stay */
        });
        io.disconnect();
      },
      { threshold: 0.35 },
    );
    io.observe(video);
    return () => io.disconnect();
  }, []);

  return (
    <video
      ref={ref}
      className="aspect-video w-full bg-black"
      controls
      muted
      loop
      playsInline
      preload="metadata"
      poster="/video/node-setup-poster.jpg"
      aria-label="Run a Sparecycle node in 4 steps: install, link a wallet, start, checked jobs arrive"
    >
      <source src="/video/node-setup.mp4" type="video/mp4" />
    </video>
  );
}
