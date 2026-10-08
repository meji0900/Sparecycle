"use client";

import DotGrid from "@/components/reactbits/DotGrid";

/**
 * A very quiet dot field behind the 404 message: dots ≈ #222, the pointer's neighbourhood tints toward a dim
 * signal green (#00c805 at about 35% over the page). No glow, no click shock; reduced motion keeps it still.
 * Without WebGL2 it renders nothing.
 */
export function DotBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <DotGrid
        dotSize={2}
        gap={22}
        baseColor="#222222"
        activeColor="#084e0a"
        proximity={130}
        strength={0.6}
        swell={0.4}
        stretch={0.2}
        glow={0}
        fade={0.6}
        clickShock={false}
        intro={false}
      />
    </div>
  );
}
