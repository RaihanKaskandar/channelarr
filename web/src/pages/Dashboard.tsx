import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PageProps } from "../App";
import { CopyField, ErrorText, Stat } from "../components/ui";
import { api, timeAgo, type EpgMethod } from "../lib/api";

const coverageParts: { key: EpgMethod[]; label: string; cls: string }[] = [
  { key: ["tvg-id", "name", "manual"], label: "Full guide", cls: "bg-ok" },
  { key: ["short-epg"], label: "Per-channel EPG", cls: "bg-warn" },
  { key: ["dummy"], label: "Placeholder", cls: "bg-bad" },
];

export default function DashboardPage({ status }: PageProps) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: (job: "playlist" | "epg") => api("POST", `/api/sync/${job}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["status"] }),
  });
  const regen = useMutation({
    mutationFn: () => api("POST", "/api/output/regenerate-token"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["status"] }),
  });

  const { source, counts, epg, jobs, output } = status;
  if (!source) {
    return (
      <div className="card mx-auto max-w-xl text-center">
        <h2 className="text-xl font-semibold">Welcome to Channelarr</h2>
        <p className="mt-2 text-sm text-muted">
          Add your Xtream Codes login first. Channelarr imports the channel list and the provider's guide, and you pick
          which channels Jellyfin gets.
        </p>
        <a href="#/source" className="btn-primary mt-5">
          Add IPTV source
        </a>
      </div>
    );
  }

  const covTotal = Object.values(epg.coverage).reduce((a, b) => a + (b ?? 0), 0);
  const covCount = (keys: EpgMethod[]) => keys.reduce((n, k) => n + (epg.coverage[k] ?? 0), 0);
  const account = source.account;
  const expiry = account?.exp_date ? new Date(Number(account.exp_date) * 1000).toLocaleDateString() : "no expiry";

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Channels in output" value={counts.included} hint={`of ${counts.streams} from the provider`} />
        <Stat
          label="With real guide data"
          value={covTotal ? `${Math.round(((covTotal - covCount(["dummy"])) / covTotal) * 100)}%` : "–"}
          hint={`EPG downloaded ${timeAgo(epg.lastDownload)}`}
        />
        <Stat
          label="Account"
          value={<span className={account?.status === "Active" ? "text-ok" : "text-warn"}>{account?.status ?? "Unknown"}</span>}
          hint={`Expires ${expiry}`}
        />
        <Stat
          label="Max connections"
          value={account?.max_connections ?? "?"}
          hint="Use this as Jellyfin's tuner limit"
        />
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">Guide coverage</h2>
          <div className="flex gap-2">
            <button className="btn-ghost" disabled={Boolean(jobs.running)} onClick={() => run.mutate("playlist")}>
              Refresh channels
            </button>
            <button className="btn-ghost" disabled={Boolean(jobs.running)} onClick={() => run.mutate("epg")}>
              Refresh EPG
            </button>
          </div>
        </div>
        {covTotal ? (
          <>
            <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-panel-2">
              {coverageParts.map((p) => (
                <div key={p.label} className={p.cls} style={{ width: `${(covCount(p.key) / covTotal) * 100}%` }} />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
              {coverageParts.map((p) => (
                <span key={p.label} className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${p.cls}`} />
                  {p.label}: <b className="text-white">{covCount(p.key)}</b>
                </span>
              ))}
            </div>
            {covCount(["dummy"]) > 0 && (
              <p className="mt-3 text-sm text-muted">
                Channels with a placeholder still work in Jellyfin, they just show the channel name in the guide.{" "}
                <a href="#/epg" className="text-accent-strong hover:underline">
                  Fix them on the EPG page
                </a>
                .
              </p>
            )}
          </>
        ) : (
          <p className="mt-3 text-sm text-muted">
            {counts.included ? "The guide is being built…" : "Include some channels first, then the guide is built for them."}
          </p>
        )}
        <div className="mt-4 grid gap-1 text-xs text-muted sm:grid-cols-2">
          {[
            { label: "Channels", last: jobs.last.playlist },
            // A rebuild after editing channels is newer than the last download, so show whichever ran last.
            { label: "Guide", last: [jobs.last.epg, jobs.last["epg-rebuild"]].sort((a, b) => (b?.finishedAt ?? 0) - (a?.finishedAt ?? 0))[0] },
          ].map(({ label, last }) => {
            // Job results are kept in memory only; after a restart fall back to the stored timestamps.
            const stored = label === "Channels" ? source.lastSyncAt : epg.lastRebuild;
            return (
              <div key={label}>
                {label}:{" "}
                {last
                  ? `${last.ok ? "✓" : "✗"} ${last.message} (${timeAgo(last.finishedAt)})`
                  : stored
                    ? `last updated ${timeAgo(stored)}`
                    : "not run yet"}
              </div>
            );
          })}
        </div>
        {source.lastSyncStatus === "error" && <ErrorText error={source.lastSyncError} />}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="card space-y-4">
          <h2 className="font-semibold">Links for Jellyfin</h2>
          <CopyField label="M3U playlist (tuner)" value={output.playlist} />
          <CopyField label="XMLTV guide" value={output.epg} />
          <CopyField label="XMLTV guide, gzipped" value={output.epgGz} />
          <div className="flex items-center justify-between gap-3 border-t border-line pt-4 text-sm text-muted">
            <span>The links contain a secret token. Anyone with them can see your channel list.</span>
            <button
              className="btn-danger shrink-0"
              onClick={() => confirm("Make new links? Jellyfin needs the new URLs afterwards.") && regen.mutate()}
            >
              New links
            </button>
          </div>
        </div>
        <div className="card text-sm">
          <h2 className="mb-3 font-semibold">Add to Jellyfin</h2>
          <ol className="list-decimal space-y-2 pl-5 text-muted">
            <li>
              Dashboard → <b className="text-white">Live TV</b> → Tuner devices → <b className="text-white">+</b> → type{" "}
              <b className="text-white">M3U Tuner</b>, paste the playlist link.
            </li>
            <li>
              Set <b className="text-white">Simultaneous stream limit</b> to {account?.max_connections ?? "your connection limit"}.
              Keep "Allow stream sharing" on.
            </li>
            <li>
              TV guide data providers → <b className="text-white">+</b> → <b className="text-white">XMLTV</b>, paste the guide link and
              enable it for the new tuner.
            </li>
            <li>
              Channels match by themselves: the playlist and the guide use the same channel ids. Run{" "}
              <b className="text-white">Refresh Guide</b> in Scheduled Tasks to load it right away.
            </li>
          </ol>
          <p className="mt-4 text-xs text-muted">
            Streams are not proxied: each link sends Jellyfin straight to your provider, so Jellyfin plays (or transcodes)
            the original stream.
          </p>
        </div>
      </div>
    </div>
  );
}
