import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import type { PageProps } from "../App";
import { GuidePicker } from "../components/GuidePicker";
import { ChannelLogo, EpgBadge, ErrorText, Toggle } from "../components/ui";
import { api, get, type Category, type Channel, type ChannelPage, type ChannelPatch, type Rule } from "../lib/api";

type Show = "all" | "included" | "excluded";
const PAGE_SIZE = 100;

export default function ChannelsPage({ status }: PageProps) {
  const qc = useQueryClient();
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [page, setPage] = useState(0);
  const [picker, setPicker] = useState<Channel | null>(null);
  const [catFilter, setCatFilter] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setSearch(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(0), [category, search, show]);

  const categories = useQuery({ queryKey: ["categories"], queryFn: () => get<Category[]>("/api/categories") });
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), show });
  if (category) params.set("category", category);
  if (search) params.set("q", search);
  const channels = useQuery({
    queryKey: ["channels", category, search, show, page],
    queryFn: () => get<ChannelPage>(`/api/channels?${params}`),
    placeholderData: keepPreviousData,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["channels"] });
    void qc.invalidateQueries({ queryKey: ["categories"] });
    void qc.invalidateQueries({ queryKey: ["status"] });
  };
  const patch = useMutation({
    mutationFn: (body: { streamIds?: number[]; filter?: object; patch: ChannelPatch }) => api("PATCH", "/api/channels", body),
    onSuccess: refresh,
  });
  const setCategoryIncluded = useMutation({
    mutationFn: ({ id, included }: { id: string; included: boolean }) =>
      api("PUT", `/api/categories/${encodeURIComponent(id)}`, { included, resetChannels: true }),
    onSuccess: refresh,
  });

  if (!status.source) {
    return (
      <div className="card text-sm text-muted">
        Add an <a className="text-accent-strong hover:underline" href="#/source">IPTV source</a> first.
      </div>
    );
  }

  const currentFilter = { category: category ?? undefined, q: search || undefined, show };
  const total = channels.data?.total ?? 0;
  const visibleCats = (categories.data ?? []).filter((c) => c.name.toLowerCase().includes(catFilter.toLowerCase()));
  const selectedCat = categories.data?.find((c) => c.id === category);

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
      <aside className="card h-fit p-3 lg:sticky lg:top-20">
        <input className="input mb-2" placeholder="Filter categories" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} />
        <button
          className={`mb-1 flex w-full justify-between rounded-lg px-2.5 py-2 text-sm ${category === null ? "bg-accent/20 text-white" : "text-muted hover:bg-panel-2"}`}
          onClick={() => setCategory(null)}
        >
          <span>All categories</span>
          <span>
            {status.counts.included}/{status.counts.streams}
          </span>
        </button>
        <div className="max-h-[65vh] overflow-y-auto pr-1">
          {visibleCats.map((c) => (
            <div
              key={c.id}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${category === c.id ? "bg-accent/20" : "hover:bg-panel-2"}`}
            >
              <Toggle
                checked={c.included}
                title="Include the whole category, including channels the provider adds later"
                onChange={(included) => setCategoryIncluded.mutate({ id: c.id, included })}
              />
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => setCategory(c.id)} title={c.name}>
                {c.name}
              </button>
              <span className={`shrink-0 text-xs ${c.includedCount ? "text-accent-strong" : "text-muted"}`}>
                {c.includedCount}/{c.total}
              </span>
            </div>
          ))}
        </div>
      </aside>

      <section className="min-w-0 space-y-4">
        <div className="card flex flex-wrap items-center gap-3 p-3">
          <input className="input max-w-xs" placeholder="Search channels" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="flex rounded-lg border border-line p-0.5 text-sm">
            {(["all", "included", "excluded"] as Show[]).map((s) => (
              <button
                key={s}
                className={`rounded-md px-3 py-1.5 capitalize ${show === s ? "bg-accent text-white" : "text-muted hover:text-white"}`}
                onClick={() => setShow(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <button className="btn-ghost" disabled={!total} onClick={() => patch.mutate({ filter: currentFilter, patch: { enabled: true } })}>
              Include {total} shown
            </button>
            <button className="btn-ghost" disabled={!total} onClick={() => patch.mutate({ filter: currentFilter, patch: { enabled: false } })}>
              Exclude {total} shown
            </button>
            <button
              className="btn-ghost"
              title="Remove manual on/off choices so the category switch and rules decide"
              disabled={!total}
              onClick={() => patch.mutate({ filter: currentFilter, patch: { enabled: null } })}
            >
              Reset
            </button>
          </div>
        </div>
        {selectedCat && (
          <p className="text-sm text-muted">
            {selectedCat.included
              ? "This whole category is included: new channels in it are added automatically. Switch single channels off below."
              : "This category is off. Switch it on in the list to include all of it, or include single channels below."}
          </p>
        )}
        <ErrorText error={patch.error ?? setCategoryIncluded.error ?? channels.error} />

        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-12 px-3 py-2.5">On</th>
                <th className="w-16 px-2 py-2.5 sm:w-20">No.</th>
                <th className="px-2 py-2.5">Channel</th>
                <th className="hidden px-2 py-2.5 md:table-cell">Group</th>
                <th className="px-2 py-2.5">Guide</th>
                <th className="hidden px-2 py-2.5 xl:table-cell">Now</th>
              </tr>
            </thead>
            <tbody>
              {channels.data?.items.map((c) => (
                <ChannelRow key={c.streamId} channel={c} onPatch={(p) => patch.mutate({ streamIds: [c.streamId], patch: p })} onPickGuide={() => setPicker(c)} />
              ))}
              {channels.data && !channels.data.items.length && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-muted">
                    No channels here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-end gap-3 text-sm text-muted">
            <span>
              {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}
            </span>
            <button className="btn-ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button className="btn-ghost" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        )}
        <RulesPanel categories={categories.data ?? []} onChange={refresh} />
      </section>
      {picker && <GuidePicker channel={picker} onClose={() => setPicker(null)} />}
    </div>
  );
}

function ChannelRow({ channel: c, onPatch, onPickGuide }: { channel: Channel; onPatch: (p: ChannelPatch) => void; onPickGuide: () => void }) {
  const [name, setName] = useState(c.name);
  const [number, setNumber] = useState(c.numberOverride?.toString() ?? "");
  useEffect(() => setName(c.name), [c.name]);
  useEffect(() => setNumber(c.numberOverride?.toString() ?? ""), [c.numberOverride]);

  const commitName = () => {
    const v = name.trim();
    if (v === c.name) return;
    onPatch({ name: !v || v === c.providerName ? null : v });
  };
  const commitNumber = () => {
    const v = number.trim();
    const n = v ? Number.parseInt(v, 10) : null;
    if (n === c.numberOverride || (v && !Number.isFinite(n))) return;
    onPatch({ number: n });
  };
  const reasonText =
    c.reason === "manual" ? "Set by hand" : c.reason === "rule" ? "Decided by a rule" : c.reason === "category" ? "Whole category included" : "Not included";

  return (
    <tr className={`border-b border-line last:border-0 ${c.included ? "" : "opacity-60"}`}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5" title={reasonText}>
          <Toggle checked={c.included} onChange={(v) => onPatch({ enabled: v })} />
          {c.reason === "manual" && <span className="h-1.5 w-1.5 rounded-full bg-accent-strong" />}
        </div>
      </td>
      <td className="px-2 py-2">
        <input
          className="input w-14 px-1.5 py-1 text-center sm:w-16"
          placeholder={c.number?.toString() ?? "–"}
          title="Leave empty to number automatically"
          value={number}
          onChange={(e) => setNumber(e.target.value.replace(/[^\d]/g, ""))}
          onBlur={commitNumber}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </td>
      <td className="min-w-40 px-2 py-2">
        <div className="flex items-center gap-2.5">
          <ChannelLogo src={c.logo} className="hidden h-8 w-8 sm:block" />
          <div className="min-w-0 flex-1">
            <input
              className="w-full truncate rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-line focus:border-accent focus:outline-none"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            {c.nameOverride && <div className="truncate px-1 text-xs text-muted">Provider: {c.providerName}</div>}
          </div>
        </div>
      </td>
      <td className="hidden max-w-48 truncate px-2 py-2 text-muted md:table-cell">{c.group}</td>
      <td className="px-2 py-2">
        {c.included ? (
          <button onClick={onPickGuide} title={c.epg?.channelId ? `Guide channel: ${c.epg.channelId}` : "Pick a guide channel"}>
            <EpgBadge method={c.epg?.method} />
          </button>
        ) : (
          <span className="text-xs text-muted">–</span>
        )}
      </td>
      <td className="hidden max-w-64 truncate px-2 py-2 text-muted xl:table-cell">{c.nowPlaying ?? ""}</td>
    </tr>
  );
}

function RulesPanel({ categories, onChange }: { categories: Category[]; onChange: () => void }) {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => get<Rule[]>("/api/rules") });
  const [form, setForm] = useState({ action: "exclude" as Rule["action"], pattern: "", isRegex: false, categoryId: "" });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["rules"] });
    onChange();
  };
  const add = useMutation({
    mutationFn: () => api("POST", "/api/rules", { ...form, categoryId: form.categoryId || null }),
    onSuccess: () => {
      setForm({ ...form, pattern: "" });
      done();
    },
  });
  const remove = useMutation({ mutationFn: (id: number) => api("DELETE", `/api/rules/${id}`), onSuccess: done });
  const catName = (id: string | null) => (id ? (categories.find((c) => c.id === id)?.name ?? id) : "all categories");
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <div className="card">
      <h3 className="font-semibold">Rules</h3>
      <p className="mt-1 text-sm text-muted">
        Rules also apply to channels the provider adds later. A manual on/off switch on a channel always wins.
        Example: exclude <code className="text-white">SD</code> or <code className="text-white">*(backup)*</code>.
      </p>
      <form onSubmit={onSubmit} className="mt-3 flex flex-wrap gap-2">
        <select className="input w-32" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value as Rule["action"] })}>
          <option value="exclude">Exclude</option>
          <option value="include">Include</option>
        </select>
        <input
          className="input min-w-48 flex-1"
          placeholder={form.isRegex ? "Regular expression" : "Name contains… (* = anything)"}
          value={form.pattern}
          onChange={(e) => setForm({ ...form, pattern: e.target.value })}
        />
        <select className="input w-48" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
          <option value="">In all categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={form.isRegex} onChange={(e) => setForm({ ...form, isRegex: e.target.checked })} /> Regex
        </label>
        <button className="btn-primary" disabled={!form.pattern.trim() || add.isPending}>
          Add rule
        </button>
      </form>
      <ErrorText error={add.error} />
      {!!rules.data?.length && (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line text-sm">
          {rules.data.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2">
              <span className={`badge ${r.action === "exclude" ? "bg-bad/15 text-bad" : "bg-ok/15 text-ok"}`}>{r.action}</span>
              <code className="flex-1 truncate">{r.pattern}</code>
              <span className="text-xs text-muted">
                {r.is_regex ? "regex · " : ""}
                {catName(r.category_id)}
              </span>
              <button className="text-muted hover:text-bad" onClick={() => remove.mutate(r.id)} aria-label="Delete rule">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
