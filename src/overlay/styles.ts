// Stili dell'overlay: vivono nello Shadow DOM chiuso, quindi non toccano l'app (e viceversa).
export const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.root {
  --brand: #b12584; --brand-soft: rgba(177, 37, 132, 0.12); --red: #e5484d; --ok: #1d9a55;
  --ink: #1b1c21; --muted: #646875; --paper: #ffffff; --line: #e2e4e9;
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink);
}
/* Durante una cattura tutto ciò che l'overlay disegna sparisce dall'immagine (per pochi
   fotogrammi); lo scudo, trasparente, resta attivo e continua a ricevere i gesti. */
.root.capturing .layer, .root.capturing .hover-box, .root.capturing .hover-label, .root.capturing .draft-rect,
.root.capturing .draw-layer, .root.capturing .frame, .root.capturing .pill { visibility: hidden !important; }
.shield { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: transparent; touch-action: none; }
.frame { position: fixed; inset: 0; box-shadow: inset 0 0 0 2px var(--brand); pointer-events: none; }
.pill {
  position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 24px);
  padding: 6px 6px 6px 12px; border-radius: 999px; background: rgba(27, 28, 33, 0.92); color: #fff;
  box-shadow: 0 6px 20px rgba(0,0,0,.25); pointer-events: auto; white-space: nowrap; font-size: 12px;
}
.pill b { font-weight: 700; }
.pill .sep { opacity: .45; }
.pill .muted { opacity: .75; overflow: hidden; text-overflow: ellipsis; }
.pill button {
  all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
  background: rgba(255,255,255,.14); font-size: 13px; line-height: 1;
}
.pill button:hover { background: rgba(255,255,255,.28); }
.hover-box {
  position: fixed; pointer-events: none; border: 2px solid var(--brand); background: var(--brand-soft);
  border-radius: 2px; transition: all 60ms ease-out;
}
.hover-label {
  position: fixed; pointer-events: none; padding: 2px 7px; border-radius: 5px; background: var(--brand); color: #fff;
  font: 600 11px/1.5 ui-monospace, "JetBrains Mono", "Cascadia Code", Menlo, monospace; white-space: nowrap;
  max-width: 70vw; overflow: hidden; text-overflow: ellipsis;
}
.hover-label .dim { opacity: .75; font-weight: 400; }
.draft-rect { position: fixed; border: 2px dashed var(--brand); background: var(--brand-soft); pointer-events: none; }
.draw-layer { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; overflow: visible; }
.mark { position: fixed; pointer-events: none; }
.mark .box { position: absolute; inset: -2px; border: 2px solid var(--brand); border-radius: 3px; background: rgba(177, 37, 132, 0.06); }
.mark.area .box { border-style: dashed; }
.mark.drawing .box { display: none; }
.mark svg { position: absolute; left: 0; top: 0; overflow: visible; }
.mark.sent .box { border-color: var(--ok); background: rgba(29, 154, 85, 0.08); }
.mark.sent { transition: opacity .5s ease .9s; opacity: 0; }
.mark.flash .box { animation: flash .9s ease-out 2; }
@keyframes flash { 0% { box-shadow: 0 0 0 0 rgba(177,37,132,.55); } 100% { box-shadow: 0 0 0 14px rgba(177,37,132,0); } }
.badge {
  position: fixed; min-width: 22px; height: 22px; padding: 0 6px; margin: -11px 0 0 -11px; border-radius: 11px;
  display: grid; place-items: center; background: var(--brand); color: #fff; font: 700 12px/1 system-ui, sans-serif;
  border: 2px solid #fff; box-shadow: 0 2px 6px rgba(0,0,0,.25); pointer-events: auto; cursor: pointer; user-select: none;
}
.badge.drawing { background: var(--red); }
.badge.sent { background: var(--ok); }
.badge.draft { background: var(--muted); }
.badge.error { background: var(--red); }
.badge:hover { transform: scale(1.08); }
`;
