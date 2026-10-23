import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { ErrorText } from "./components/ui";
import { api, get, type Status } from "./lib/api";
import ChannelsPage from "./pages/Channels";
import DashboardPage from "./pages/Dashboard";
import EpgPage from "./pages/Epg";
import SettingsPage from "./pages/Settings";
import SourcePage from "./pages/Source";

const pages = {
  dashboard: { label: "Overview", component: DashboardPage },
  source: { label: "IPTV source", component: SourcePage },
  channels: { label: "Channels", component: ChannelsPage },
  epg: { label: "EPG", component: EpgPage },
  settings: { label: "Settings", component: SettingsPage },
} as const;
type PageKey = keyof typeof pages;

const currentPage = (): PageKey => {
  const key = window.location.hash.replace(/^#\/?/, "") as PageKey;
  return key in pages ? key : "dashboard";
};

export default function App() {
  const auth = useQuery({
    queryKey: ["auth"],
    queryFn: () => get<{ setupRequired: boolean; authenticated: boolean }>("/api/auth/state"),
  });
  if (auth.isPending) return null;
  if (auth.data?.setupRequired) return <PasswordScreen mode="setup" />;
  if (!auth.data?.authenticated) return <PasswordScreen mode="login" />;
  return <Shell />;
}

function PasswordScreen({ mode }: { mode: "setup" | "login" }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const submit = useMutation({
    mutationFn: () => {
      if (mode === "setup" && password !== confirm) throw new Error("Passwords don't match");
      return api("POST", `/api/auth/${mode}`, { password });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={onSubmit} className="card w-full max-w-sm space-y-4">
        <Logo />
        <p className="text-sm text-muted">
          {mode === "setup" ? "Choose an admin password for this Channelarr install." : "Sign in to manage your channels."}
        </p>
        <div>
          <label className="label" htmlFor="pw">
            Password
          </label>
          <input id="pw" className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {mode === "setup" && (
          <div>
            <label className="label" htmlFor="pw2">
              Repeat password
            </label>
            <input id="pw2" className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
        )}
        <button className="btn-primary w-full" disabled={!password || submit.isPending}>
          {mode === "setup" ? "Create password" : "Sign in"}
        </button>
        <ErrorText error={submit.error} />
      </form>
    </div>
  );
}

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/favicon.svg" alt="" className="h-8 w-8" />
      <span className="text-lg font-semibold tracking-tight">Channelarr</span>
    </div>
  );
}

function Shell() {
  const qc = useQueryClient();
  const [page, setPage] = useState<PageKey>(currentPage);
  useEffect(() => {
    const onHash = () => setPage(currentPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => get<Status>("/api/status"),
    // Poll fast while a job runs so progress and results show up without reloading.
    refetchInterval: (q) => (q.state.data?.jobs.running ? 2000 : 15000),
  });
  const wasRunning = status.data?.jobs.running;
  useEffect(() => {
    if (!wasRunning) {
      void qc.invalidateQueries({ queryKey: ["channels"] });
      void qc.invalidateQueries({ queryKey: ["categories"] });
      void qc.invalidateQueries({ queryKey: ["epg-sources"] });
    }
  }, [wasRunning, qc]);

  const logout = useMutation({
    mutationFn: () => api("POST", "/api/auth/logout"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
  });

  const Page = pages[page].component;
  const jobs = status.data?.jobs;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Logo />
          <nav className="flex flex-wrap gap-1">
            {(Object.keys(pages) as PageKey[]).map((key) => (
              <a
                key={key}
                href={`#/${key}`}
                className={`rounded-full px-3.5 py-1.5 text-sm transition ${
                  page === key ? "bg-accent text-white" : "text-muted hover:bg-panel-2 hover:text-white"
                }`}
              >
                {pages[key].label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {jobs?.running && (
              <span className="flex items-center gap-2 text-muted">
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                {jobs.step ?? `Running ${jobs.running}…`}
              </span>
            )}
            <button className="text-muted hover:text-white" onClick={() => logout.mutate()}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{status.data && <Page status={status.data} />}</main>
    </div>
  );
}

export interface PageProps {
  status: Status;
}
