import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { PageProps } from "../App";
import { GuidePicker } from "../components/GuidePicker";
import { ChannelLogo, EpgBadge, ErrorText, Toggle } from "../components/ui";
import { api, get, timeAgo, type Channel, type ChannelPage, type EpgSource } from "../lib/api";

type Filter = "dummy" | "short-epg" | "tvg-id,name,manual";
const filters: { key: Filter; label: string }[] = [
  { key: "dummy", label: "Placeholder only" },
  { key: "short-epg", label: "Per-channel EPG" },
  { key: "tvg-id,name,manual", label: "Full guide" },
];

export default function EpgPage({ status }: PageProps) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("dummy");
  const [picker, setPicker] = useState<Channel | null>(null);
  const sources = useQuery({ queryKey: ["epg-sources"], queryFn: () => get<EpgSource[]>("/api/epg/sources") });
  const list = useQuery({
    queryKey: ["channels", "epg", filter],
    queryFn: () => get<ChannelPage>(`/api/channels?show=included&pageSize=500&epg=${filter}`),
  });
  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["epg-sources"] });
    void qc.invalidateQueries({ queryKey: ["status"] });
  };
  const refreshEpg = useMutation({ mutationFn: () => api("POST", "/api/sync/epg"), onSuccess: refreshAll });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api("PATCH", `/api/epg/sources/${id}`, { enabled }),
    onSuccess: refreshAll,
  });
  const remove = useMutation({ mutationFn: (id: number) => api("DELETE", `/api/epg/sources/${id}`), onSuccess: refreshAll });

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Guide sources</h2>
            <p className="mt-1 text-sm text-muted">
              For each channel the first source that has it wins, top to bottom. Channels no source covers get the provider's
              per-channel EPG, and otherwise a placeholder.
            </p>
          </div>
          <button className="btn-primary" disabled={Boolean(status.jobs.running)} onClick={() => refreshEpg.mutate()}>
            Download guides now
          </button>
        </div>
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line">
          {sources.data?.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <Toggle checked={s.enabled === 1} onChange={(enabled) => toggle.mutate({ id: s.id, enabled })} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{s.name}</div>
                <div className="truncate text-xs text-muted">{s.kind === "xtream" ? "xmltv.php from your IPTV provider" : s.url}</div>
              </div>
              <div className="text-right text-xs text-muted">
                <div>
                  {s.channel_count.toLocaleString()} channels · {s.programme_count.toLocaleString()} programmes in use
                </div>
                <div className={s.status === "error" ? "text-bad" : ""}>
                  {s.status === "error" ? s.error : `Downloaded ${timeAgo(s.last_fetch_at)}`}
                </div>
              </div>
              {s.kind === "xmltv" && (
                <button className="text-muted hover:text-bad" onClick={() => confirm(`Remove ${s.name}?`) && remove.mutate(s.id)} aria-label="Remove">
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        <AddSource onAdded={refreshAll} />
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Channels by guide status</h2>
          <div className="flex rounded-lg border border-line p-0.5 text-sm">
            {filters.map((f) => (
              <button
                key={f.key}
                className={`rounded-md px-3 py-1.5 ${filter === f.key ? "bg-accent text-white" : "text-muted hover:text-white"}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label} {f.key === "dummy" && status.epg.coverage.dummy ? `(${status.epg.coverage.dummy})` : ""}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-1 text-sm text-muted">Click a channel to pick its guide channel by hand.</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {list.data?.items.map((c) => (
            <button
              key={c.streamId}
              onClick={() => setPicker(c)}
              className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2 text-left text-sm hover:border-accent"
            >
              <ChannelLogo src={c.logo} className="h-8 w-8" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {c.number}. {c.name}
                </span>
                <span className="block truncate text-xs text-muted">{c.nowPlaying ?? c.epg?.channelId ?? (c.epgChannelId ? `tvg-id ${c.epgChannelId} not in any guide` : "no tvg-id from provider")}</span>
              </span>
              <EpgBadge method={c.epg?.method} />
            </button>
          ))}
        </div>
        {list.data && !list.data.items.length && <p className="mt-4 text-sm text-muted">Nothing here.</p>}
      </div>
      {picker && <GuidePicker channel={picker} onClose={() => setPicker(null)} />}
    </div>
  );
}

function AddSource({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api("POST", "/api/epg/sources", { url, name: name || undefined }),
    onSuccess: () => {
      setUrl("");
      setName("");
      onAdded();
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <form onSubmit={onSubmit} className="mt-4">
      <span className="label">Add an XMLTV source (.xml or .xml.gz)</span>
      <div className="flex flex-wrap gap-2">
        <input className="input w-40" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input min-w-64 flex-1" type="url" required placeholder="https://epgshare01.online/epgshare01/epg_ripper_DE1.xml.gz" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn-ghost" disabled={add.isPending}>
          Add
        </button>
      </div>
      <ErrorText error={add.error} />
    </form>
  );
}
