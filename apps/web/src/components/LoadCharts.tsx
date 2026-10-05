import { useState } from "react";
import type { LoadSample } from "@testforge/shared";

// Paleta validada (modo oscuro): azul, naranja, aqua, amarillo
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500"] as const;
const AXIS = "var(--muted)";
const GRID = "#2a313b";

type Line = { key: keyof LoadSample; label: string; color: string };

// Gráfica de líneas de tiempo con eje único, leyenda y tooltip al pasar el mouse
export function TimeChart({ samples, lines, unit, title, height = 180 }: {
  samples: LoadSample[]; lines: Line[]; unit: string; title: string; height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 680, h = height, padL = 46, padR = 12, padT = 10, padB = 22;
  const iw = w - padL - padR, ih = h - padT - padB;
  const n = samples.length;
  const maxT = Math.max(1, ...samples.map((s) => s.t));
  const maxY = Math.max(1, ...samples.flatMap((s) => lines.map((l) => Number(s[l.key]))));
  const niceMax = niceCeil(maxY);
  const x = (t: number) => padL + (maxT === 0 ? 0 : (t / maxT) * iw);
  const y = (v: number) => padT + ih - (v / niceMax) * ih;

  const path = (l: Line) => samples.map((s, i) => `${i === 0 ? "M" : "L"}${x(s.t).toFixed(1)} ${y(Number(s[l.key])).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    if (px < padL || px > w - padR || n === 0) { setHover(null); return; }
    const t = ((px - padL) / iw) * maxT;
    let best = 0, bd = Infinity;
    samples.forEach((s, i) => { const d = Math.abs(s.t - t); if (d < bd) { bd = d; best = i; } });
    setHover(best);
  };

  const hs = hover !== null ? samples[hover] : null;

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="chart-legend">
          {lines.map((l) => (
            <span key={String(l.key)} className="leg"><i style={{ background: l.color }} />{l.label}</span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={title}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={w - padR} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth="1" />
            <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill={AXIS}>{fmt(v)}</text>
          </g>
        ))}
        <text x={padL} y={h - 6} fontSize="10" fill={AXIS}>0 s</text>
        <text x={w - padR} y={h - 6} textAnchor="end" fontSize="10" fill={AXIS}>{maxT} s</text>
        <text x={4} y={padT + 8} fontSize="10" fill={AXIS}>{unit}</text>
        {lines.map((l) => <path key={String(l.key)} d={path(l)} fill="none" stroke={l.color} strokeWidth="2" />)}
        {hs && (
          <>
            <line x1={x(hs.t)} x2={x(hs.t)} y1={padT} y2={padT + ih} stroke={AXIS} strokeWidth="1" strokeDasharray="3 3" />
            {lines.map((l) => <circle key={String(l.key)} cx={x(hs.t)} cy={y(Number(hs[l.key]))} r="3.5" fill={l.color} stroke="var(--panel)" strokeWidth="1.5" />)}
          </>
        )}
      </svg>
      {hs && (
        <div className="chart-tip">
          <b>{hs.t} s</b>
          {lines.map((l) => <span key={String(l.key)}><i style={{ background: l.color }} />{l.label}: {fmt(Number(hs[l.key]))} {unit}</span>)}
        </div>
      )}
    </div>
  );
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}
function fmt(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return `${Math.round(v * 10) / 10}`;
}
