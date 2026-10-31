// Small pixel props (rocks, flowers, a mushroom, a bush) placed on a <Ground /> strip so the grass
// does not read as one repeating tile. Each sprite is a character grid; "." is transparent.

const SPRITES = {
  rock: {
    palette: { L: "#c4beb1", M: "#9c9587", D: "#746d60", S: "#5c564b" },
    rows: ["...LLLM...", "..LLMMMMD.", ".LLMMMMMDD", "LMMMMMDDDD", "MMMDDDDDSS"],
  },
  pebble: {
    palette: { L: "#c4beb1", M: "#9c9587", D: "#746d60" },
    rows: [".LLM.", "LMMDD"],
  },
  mossRock: {
    palette: { G: "#74bb45", g: "#4f9d36", L: "#c4beb1", M: "#9c9587", D: "#746d60" },
    rows: [".gGGg..", "gGLLMg.", "LLMMMDD", "MMMMDDD"],
  },
  poppy: {
    palette: { R: "#d8473c", r: "#a8322b", Y: "#f2c94c", g: "#4f9d36" },
    rows: [".R.", "RYr", ".r.", ".g.", "gg.", ".g."],
  },
  daisy: {
    palette: { W: "#f6f2e6", Y: "#f2c94c", g: "#4f9d36" },
    rows: [".W.", "WYW", ".W.", ".g.", ".gg", ".g."],
  },
  mushroom: {
    palette: { R: "#c9413a", r: "#9e2f29", W: "#f6f2e6", C: "#eadcbe", c: "#cdbb98" },
    rows: [".RRRR.", "RWRRWR", "rRRRRr", "..Cc..", "..Cc.."],
  },
  bush: {
    palette: { H: "#a2d667", L: "#74bb45", M: "#4f9d36", D: "#3f8a33" },
    rows: ["...HLL....", "..HLLLLM..", ".HLLMLLLM.", "LLLMMMLLMM", "LMMMDMMMMD", "MMDMMMMDMM"],
  },
} as const;

export type Sprite = keyof typeof SPRITES;

function PixelSprite({ name, cell }: { name: Sprite; cell: number }) {
  const { palette, rows } = SPRITES[name];
  const w = rows[0].length;
  const h = rows.length;
  return (
    <svg width={w * cell} height={h * cell} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" className="block">
      {rows.flatMap((row, y) =>
        [...row].map((ch, x) => (ch in palette ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={palette[ch as keyof typeof palette]} /> : null)),
      )}
    </svg>
  );
}

export type Prop = { sprite: Sprite; /** distance from the left edge, e.g. "62%" */ left: string; flip?: boolean };

/** Props standing on the grass base, `cell` px per sprite pixel. */
export function GroundDecor({ items, cell, base }: { items: Prop[]; cell: number; base: number }) {
  return (
    <>
      {items.map(({ sprite, left, flip }, i) => (
        <div key={i} className="absolute" style={{ left, bottom: base, transform: flip ? "scaleX(-1)" : undefined }}>
          <PixelSprite name={sprite} cell={cell} />
        </div>
      ))}
    </>
  );
}
