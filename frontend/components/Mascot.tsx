"use client";

import { useEffect, useState } from "react";
import frames from "@/lib/mascot-frames.json";

// Pixel crab. Sheets in public/mascot are grids (scripts repacked from one long strip); durations come per frame.
export type Animation = keyof typeof frames;

// Vertical window that holds the crab in every animation (frames are 128 px tall with empty sky above).
const CROP = { y: 8, h: 80 };

type Props = {
  /** Played in order; the last one loops. */
  play: Animation[];
  scale?: number;
  /** Rest on the last frame between loops. */
  pauseMs?: number;
  flip?: boolean;
  className?: string;
  label?: string;
};

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Mascot({ play, scale = 2, pauseMs = 0, flip = false, className = "", label }: Props) {
  const key = play.join(",");
  const [pos, setPos] = useState({ clip: 0, frame: 0 });

  useEffect(() => setPos({ clip: 0, frame: 0 }), [key]);

  useEffect(() => {
    if (reducedMotion()) return;
    const clip = play[pos.clip];
    const meta = frames[clip];
    const last = pos.frame === meta.durations.length - 1;
    const looping = pos.clip === play.length - 1;
    const wait = meta.durations[pos.frame] + (last && looping ? pauseMs : 0);
    const timer = setTimeout(() => {
      if (!last) setPos({ clip: pos.clip, frame: pos.frame + 1 });
      else if (!looping) setPos({ clip: pos.clip + 1, frame: 0 });
      else setPos({ clip: pos.clip, frame: 0 });
    }, wait);
    return () => clearTimeout(timer);
  }, [pos, key, pauseMs]);

  const clip = play[Math.min(pos.clip, play.length - 1)];
  const meta = frames[clip];
  const frame = Math.min(pos.frame, meta.durations.length - 1);
  const rows = Math.ceil(meta.durations.length / meta.cols);
  const col = frame % meta.cols;
  const row = Math.floor(frame / meta.cols);
  return (
    <div
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`pixelated shrink-0 ${className}`}
      style={{
        width: meta.w * scale,
        height: CROP.h * scale,
        backgroundImage: `url(/mascot/${clip}.png)`,
        backgroundSize: `${meta.cols * meta.w * scale}px ${rows * meta.h * scale}px`,
        backgroundPosition: `${-col * meta.w * scale}px ${-(row * meta.h + CROP.y) * scale}px`,
        transform: flip ? "scaleX(-1)" : undefined,
      }}
    />
  );
}

/** Thin grass-on-dirt strip the crab stands on. */
export function Ground({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`ground h-2 w-full ${className}`} />;
}
