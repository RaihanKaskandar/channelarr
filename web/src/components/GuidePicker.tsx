import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, get, type Channel, type ChannelPatch, type GuideChannel } from "../lib/api";
import { ChannelLogo, ErrorText, Modal } from "./ui";

/** Lets the user pick the guide channel for one stream by hand, or fall back to auto/placeholder. */
export function GuidePicker({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(channel.name.replace(/^[A-Z]{2,4}\s*[:|-]\s*/, ""));
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const results = useQuery({
    queryKey: ["guide-channels", debounced],
    queryFn: () => get<GuideChannel[]>(`/api/epg/channels?q=${encodeURIComponent(debounced)}`),
  });
  const save = useMutation({
    mutationFn: (patch: ChannelPatch) => api("PATCH", "/api/channels", { streamIds: [channel.streamId], patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["channels"] });
      onClose();
    },
  });

  return (
    <Modal title={`Guide for ${channel.name}`} onClose={onClose}>
      <input className="input" autoFocus placeholder="Search guide channels by name or id" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-line">
        {results.data?.length === 0 && <p className="p-4 text-sm text-muted">No guide channels match.</p>}
        {results.data?.map((r) => (
          <button
            key={`${r.sourceId}:${r.channelId}`}
            className="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left text-sm last:border-0 hover:bg-panel-2"
            onClick={() => save.mutate({ epgMode: "manual", epgSourceId: r.sourceId, epgChannelId: r.channelId })}
          >
            <ChannelLogo src={r.icon} className="h-7 w-7" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{r.names[0] ?? r.channelId}</span>
              <span className="block truncate text-xs text-muted">
                {r.channelId} · {r.sourceName}
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" onClick={() => save.mutate({ epgMode: "auto", epgSourceId: null, epgChannelId: null })}>
          Back to automatic
        </button>
        <button className="btn-ghost" onClick={() => save.mutate({ epgMode: "dummy", epgSourceId: null, epgChannelId: null })}>
          Use placeholder
        </button>
      </div>
      <p className="mt-3 text-xs text-muted">The guide is rebuilt a few seconds after a change.</p>
      <ErrorText error={save.error} />
    </Modal>
  );
}
