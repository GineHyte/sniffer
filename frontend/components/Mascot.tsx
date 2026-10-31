// Pixel sniffer. Each clip in public/web is a self-looping animated WebP at native 47x35,
// scaled up crisp by CSS. public/web/still holds the first frame for reduced-motion users.
export const ANIMATIONS = [
  "baby_00_idle",
  "baby_01_walk",
  "baby_02_sit",
  "baby_03_glasses",
  "baby_03b_glasses_bounce",
  "baby_03c_glasses_idle",
  "baby_04_sad",
  "baby_04b_sad_stand",
  "baby_04c_sad_lying",
  "baby_04d_sad_walk",
] as const;
export type Animation = (typeof ANIMATIONS)[number];

const W = 47;
const H = 35;
// Empty rows under the feet in every clip; pulled down so the sniffer stands on <Ground />.
const FOOT_GAP = 2;

type Props = {
  play: Animation;
  /** Whole numbers keep pixels crisp. */
  scale?: number;
  flip?: boolean;
  /** Sits on a <Ground /> strip: drops the empty rows under the feet. */
  onGround?: boolean;
  className?: string;
  label?: string;
};

export function Mascot({ play, scale = 2, flip = false, onGround = false, className = "", label }: Props) {
  return (
    <picture
      className={`block shrink-0 ${className}`}
      style={{ marginBottom: onGround ? -FOOT_GAP * scale : undefined, transform: flip ? "scaleX(-1)" : undefined }}
    >
      <source srcSet={`/web/still/${play}.png`} media="(prefers-reduced-motion: reduce)" />
      <img
        src={`/web/${play}@1x.webp`}
        width={W * scale}
        height={H * scale}
        alt={label ?? ""}
        aria-hidden={label ? undefined : true}
        draggable={false}
        className="pixelated block"
      />
    </picture>
  );
}

/** Thin grass-on-dirt strip the crab stands on. */
export function Ground({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`ground h-2 w-full ${className}`} />;
}
