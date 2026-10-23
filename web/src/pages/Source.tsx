import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { PageProps } from "../App";
import { ErrorText } from "../components/ui";
import { api, timeAgo, type Account } from "../lib/api";

export default function SourcePage({ status }: PageProps) {
  const qc = useQueryClient();
  const s = status.source;
  const [form, setForm] = useState({
    serverUrl: s?.serverUrl ?? "",
    username: s?.username ?? "",
    password: "",
    userAgent: s?.userAgent ?? "",
    streamFormat: s?.streamFormat ?? "ts",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const body = () => ({ ...form, password: form.password || undefined, userAgent: form.userAgent || null });

  const test = useMutation({ mutationFn: () => api<{ account: Account }>("POST", "/api/source/test", body()) });
  const save = useMutation({
    mutationFn: () => api("PUT", "/api/source", body()),
    onSuccess: () => {
      setForm((f) => ({ ...f, password: "" }));
      void qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const account = test.data?.account;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <form onSubmit={onSubmit} className="card space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Xtream Codes login</h2>
          <p className="mt-1 text-sm text-muted">
            The details from your provider. A URL like <code className="text-white">http://host:8080</code> is enough; a pasted
            player_api.php or get.php link works too.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="url">
            Server URL
          </label>
          <input id="url" className="input" required placeholder="http://provider.example:8080" value={form.serverUrl} onChange={set("serverUrl")} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="user">
              Username
            </label>
            <input id="user" className="input" required autoComplete="off" value={form.username} onChange={set("username")} />
          </div>
          <div>
            <label className="label" htmlFor="pass">
              Password
            </label>
            <input
              id="pass"
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder={s?.hasPassword ? "Unchanged" : ""}
              required={!s?.hasPassword}
              value={form.password}
              onChange={set("password")}
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="ua">
              User agent (optional)
            </label>
            <input id="ua" className="input" placeholder="Default browser user agent" value={form.userAgent} onChange={set("userAgent")} />
          </div>
          <div>
            <label className="label" htmlFor="fmt">
              Stream format
            </label>
            <select id="fmt" className="input" value={form.streamFormat} onChange={set("streamFormat")}>
              <option value="ts">MPEG-TS (.ts) – best for Jellyfin</option>
              <option value="m3u8">HLS (.m3u8)</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button type="button" className="btn-ghost" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? "Testing…" : "Test login"}
          </button>
          <button className="btn-primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save and import channels"}
          </button>
        </div>
        <ErrorText error={test.error ?? save.error} />
        {save.isSuccess && <p className="text-sm text-ok">Saved. Channels and the guide are being imported now.</p>}
      </form>

      <div className="space-y-4">
        {account && (
          <div className="card text-sm">
            <h3 className="mb-2 font-semibold text-ok">Login works</h3>
            <AccountInfo account={account} />
          </div>
        )}
        {s && (
          <div className="card text-sm">
            <h3 className="mb-2 font-semibold">Saved source</h3>
            <dl className="space-y-1 text-muted">
              <Row k="Server" v={s.serverUrl} />
              <Row k="Username" v={s.username} />
              <Row k="Last import" v={`${timeAgo(s.lastSyncAt)}${s.lastSyncStatus === "error" ? " (failed)" : ""}`} />
            </dl>
            {s.account && (
              <div className="mt-3 border-t border-line pt-3">
                <AccountInfo account={s.account} />
              </div>
            )}
            <ErrorText error={s.lastSyncStatus === "error" ? s.lastSyncError : null} />
          </div>
        )}
        <div className="card text-xs text-muted">
          Your password is stored in Channelarr's database on this server, because each stream link needs it. It is never
          shown again and not written to Jellyfin.
        </div>
      </div>
    </div>
  );
}

function AccountInfo({ account }: { account: Account }) {
  const expiry = account.exp_date ? new Date(Number(account.exp_date) * 1000).toLocaleDateString() : "No expiry";
  return (
    <dl className="space-y-1 text-muted">
      <Row k="Status" v={account.status ?? "?"} />
      <Row k="Expires" v={expiry} />
      <Row k="Connections" v={`${account.active_cons ?? 0} of ${account.max_connections ?? "?"} in use`} />
      {account.server_timezone && <Row k="Timezone" v={account.server_timezone} />}
    </dl>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-4">
    <dt>{k}</dt>
    <dd className="truncate text-white">{v}</dd>
  </div>
);
