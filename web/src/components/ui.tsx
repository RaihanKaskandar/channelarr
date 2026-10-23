import { useEffect, useState, type ReactNode } from "react";
import type { EpgMethod } from "../lib/api";

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API needs https or localhost; fall back to selecting the text.
      const el = document.createElement("textarea");
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex gap-2">
        <input className="input font-mono text-xs" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn-ghost shrink-0" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

const methodStyle: Record<EpgMethod, { label: string; cls: string; title: string }> = {
  "tvg-id": { label: "Guide", cls: "bg-ok/15 text-ok", title: "Matched by the provider's tvg-id" },
  name: { label: "Guide (name)", cls: "bg-ok/15 text-ok", title: "Matched by channel name" },
  manual: { label: "Manual", cls: "bg-accent/20 text-accent-strong", title: "Guide channel picked by hand" },
  "short-epg": { label: "Per-channel", cls: "bg-warn/15 text-warn", title: "From the provider's per-channel EPG" },
  dummy: { label: "Placeholder", cls: "bg-bad/15 text-bad", title: "No guide data: placeholder blocks" },
};

export function EpgBadge({ method }: { method: EpgMethod | undefined }) {
  if (!method) return <span className="badge bg-panel-2 text-muted">Pending</span>;
  const s = methodStyle[method];
  return (
    <span className={`badge ${s.cls}`} title={s.title}>
      {s.label}
    </span>
  );
}

export function Toggle({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-accent" : "bg-line"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh]" onClick={onClose}>
      <div className="card w-full max-w-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button className="text-muted hover:text-white" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Channel logo that falls back to an empty tile when the provider's image is missing or broken. */
export function ChannelLogo({ src, className = "" }: { src: string | null | undefined; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <span className={`shrink-0 rounded bg-panel-2 ${className}`} />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded bg-panel-2 object-contain ${className}`}
    />
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="mt-2 text-sm text-bad">{error instanceof Error ? error.message : String(error)}</p>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}
