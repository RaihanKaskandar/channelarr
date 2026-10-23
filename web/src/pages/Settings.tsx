import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { ErrorText, Toggle } from "../components/ui";
import { api, get, type Settings } from "../lib/api";

const fields: { key: keyof Settings; label: string; hint: string; min: number; max: number }[] = [
  { key: "startNumber", label: "First channel number", hint: "Auto-numbering starts here; fixed numbers are kept.", min: 1, max: 99999 },
  { key: "epgDays", label: "Guide days ahead", hint: "How far ahead the exported guide goes.", min: 1, max: 14 },
  { key: "epgPastDays", label: "Guide days back", hint: "Keeps earlier programmes in the guide.", min: 0, max: 3 },
  { key: "playlistRefreshHours", label: "Channel refresh (hours)", hint: "How often the channel list is re-imported.", min: 1, max: 168 },
  { key: "epgRefreshHours", label: "Guide download (hours)", hint: "How often guides are downloaded again.", min: 1, max: 168 },
  { key: "shortEpgMaxChannels", label: "Per-channel EPG limit", hint: "Max channels fetched one by one per refresh.", min: 0, max: 5000 },
  { key: "dummyBlockMinutes", label: "Placeholder length (min)", hint: "Length of placeholder programmes.", min: 15, max: 720 },
];

export default function SettingsPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<Settings>("/api/settings") });
  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (s: Settings) => api<Settings>("PUT", "/api/settings", s),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      void qc.invalidateQueries({ queryKey: ["channels"] });
    },
  });
  if (!form) return null;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(form);
  };

  return (
    <form onSubmit={onSubmit} className="card max-w-3xl space-y-5">
      <h2 className="text-lg font-semibold">Settings</h2>
      <div className="grid gap-5 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="label" htmlFor={f.key}>
              {f.label}
            </label>
            <input
              id={f.key}
              className="input"
              type="number"
              min={f.min}
              max={f.max}
              value={form[f.key] as number}
              onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
            />
            <p className="mt-1 text-xs text-muted">{f.hint}</p>
          </div>
        ))}
      </div>
      <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm">
        <Toggle checked={form.cleanNames} onChange={(v) => setForm({ ...form, cleanNames: v })} />
        <span>
          <span className="block font-medium">Clean up channel names</span>
          <span className="text-muted">
            Remove country prefixes and quality tags ("NL 4K-RTL CRIME" becomes "RTL Crime", using the guide's spelling for
            names in capitals). Names you set yourself are never changed.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm">
        <Toggle checked={form.shortEpgFallback} onChange={(v) => setForm({ ...form, shortEpgFallback: v })} />
        <span>
          <span className="block font-medium">Per-channel EPG fallback</span>
          <span className="text-muted">
            For channels the guides don't cover, ask the provider's API for that channel's programmes. Slower, but often fills
            the gaps.
          </span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button className="btn-primary" disabled={save.isPending}>
          Save
        </button>
        {save.isSuccess && <span className="text-sm text-ok">Saved</span>}
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}
