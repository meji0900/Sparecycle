"use client";

import dynamic from "next/dynamic";

// WebGL2 shader; never rendered on the server. Until it loads (or without WebGL2) the page colour shows.
const HoloMosaic = dynamic(() => import("@/components/reactbits/HoloMosaic"), { ssr: false, loading: () => null });

/**
 * Background of every dApp page: a slow, near-silver tile mosaic in the page colour.
 * Tuned down so tables and numbers stay the brightest thing on screen; reduced motion gets a still frame
 * (handled inside the component). Fixed behind the content and the rail.
 */
export function AppBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
      <HoloMosaic
        color="#0c0c0c"
        metalColor="#8d928f"
        spectrum="cool"
        tileSize={1.1}
        gap={0.08}
        roundness={0.15}
        bevel={0.35}
        scatter={0.3}
        tilt={0.35}
        ripple={0.6}
        saturation={0.12}
        intensity={0.85}
        glitter={0.5}
        sheen={0.5}
        grain={0.06}
        speed={0.4}
        fade={0.12}
        opacity={0.85}
        intro
        mouseInteraction
        flipOnClick
        dpr={1}
      />
      {/* legibility scrim: muted text must keep at least 4.5:1 over the brightest tiles */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(12,12,12,0.55)_0%,rgba(12,12,12,0.35)_45%,rgba(12,12,12,0.5)_100%)]" />
    </div>
  );
}
