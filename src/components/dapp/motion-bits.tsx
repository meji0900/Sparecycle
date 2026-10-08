"use client";

// React Bits pieces restyled to the Sparecycle tokens: flat, no glow, green only as state.
// Every one renders its final state under prefers-reduced-motion (the components check it themselves).
import Counter from "@/components/reactbits/Counter";
import SplitFlapText from "@/components/reactbits/SplitFlapText";
import { useNow } from "@/lib/dapp/use-api";
import { cn } from "@/lib/utils";

/** A live integer as odometer digits. No intro roll from zero: it only moves when the value changes. */
export function OdometerNumber({ value, className, minDigits = 1 }: { value: number; className?: string; minDigits?: number }) {
  return (
    <Counter
      value={value}
      minDigits={minDigits}
      fontSize="inherit"
      intro={false}
      motionBlur={false}
      bounce={0.1}
      duration={0.55}
      fade={0.12}
      direction="shortest"
      format={{ useGrouping: true }}
      className={cn("num", className)}
    />
  );
}

/**
 * Time left until `endsAt` (unix seconds) as hh:mm:ss odometer digits. Renders nothing until the clock is known
 * on the client, and nothing once the end has passed, so it can never show a made-up timer.
 */
export function Countdown({ endsAt, className, ended }: { endsAt: number; className?: string; ended?: React.ReactNode }) {
  const now = useNow(1000);
  if (now === null) return null;
  const left = Math.floor(endsAt - now / 1000);
  if (left <= 0) return <>{ended ?? null}</>;
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const part = (v: number) => (
    <Counter value={v} minDigits={2} fontSize="inherit" intro={false} motionBlur={false} bounce={0} duration={0.35} fade={0.12} direction="shortest" format={{ useGrouping: false }} />
  );
  return (
    <span className={cn("num inline-flex items-baseline", className)} role="timer" aria-label={`${h} hours ${m} minutes ${s} seconds left`}>
      {part(h)}
      <span aria-hidden className="px-[1px] text-faint">
        :
      </span>
      {part(m)}
      <span aria-hidden className="px-[1px] text-faint">
        :
      </span>
      {part(s)}
    </span>
  );
}

/** A short status word on flat split-flap tiles (one word, sentence case). */
export function FlapWord({ text, className }: { text: string; className?: string }) {
  return (
    <SplitFlapText
      text={text}
      loop={false}
      padTo={text.length}
      fontSize={18}
      gap={2}
      tileRadius={3}
      tileStyle="board"
      tileColor="#141414"
      textColor="#ededed"
      depth={0}
      glare={0}
      flipsPerChar={5}
      flipDuration={0.07}
      stagger={0.04}
      charset="abcdefghijklmnopqrstuvwxyz"
      className={className}
    />
  );
}
