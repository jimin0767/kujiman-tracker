import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart, ComposedChart, Line, ReferenceLine, Cell, PieChart, Pie } from "recharts";

/* ═══ CONFIG ═══ */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const KUJIMAN_API_BASE = import.meta.env.VITE_KUJIMAN_API_BASE || "/kujiman-api";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("Missing Supabase environment variables.");
}

const REST = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

/* ═══ MATH ═══ */
const mean = a => a.length ? a.reduce((s,v) => s+v, 0) / a.length : 0;
const median = a => { if (!a.length) return 0; const s=[...a].sort((x,y)=>x-y), m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function getHistoryGapBand(gap, expectedGap) {
  if (!Number.isFinite(gap) || !Number.isFinite(expectedGap) || expectedGap <= 0) return "neutral";
  if (gap === expectedGap) return "exact";
  if (gap < expectedGap * 0.8) return "low";
  if (gap < expectedGap) return "nearLow";
  if (gap <= expectedGap * 1.2) return "nearHigh";
  return "high";
}

function getHistoryGapColor(gap, expectedGap) {
  const band = getHistoryGapBand(gap, expectedGap);
  if (band === "low") return C.green;
  if (band === "nearLow") return C.yellow;
  if (band === "exact") return C.gray;
  if (band === "nearHigh") return C.orange;
  if (band === "high") return C.red;
  return C.dim;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const full = normalized.length === 3 ? normalized.split("").map(ch => ch + ch).join("") : normalized;
  const value = parseInt(full, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function mixHex(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const blend = key => Math.round(ca[key] + (cb[key] - ca[key]) * clamp(t, 0, 1));
  return `rgb(${blend("r")}, ${blend("g")}, ${blend("b")})`;
}

function getGapGradientColor(gap, expectedGap) {
  if (!Number.isFinite(gap) || !Number.isFinite(expectedGap) || expectedGap <= 0) return C.dim;
  const ratio = clamp(gap / expectedGap, 0, 2);
  const anchors = [
    { ratio: 0, color: C.green },
    { ratio: 0.8, color: C.yellow },
    { ratio: 1.0, color: C.gray },
    { ratio: 1.2, color: C.orange },
    { ratio: 2.0, color: C.red },
  ];
  for (let i = 0; i < anchors.length - 1; i++) {
    const left = anchors[i];
    const right = anchors[i + 1];
    if (ratio >= left.ratio && ratio <= right.ratio) {
      const span = right.ratio - left.ratio || 1;
      return mixHex(left.color, right.color, (ratio - left.ratio) / span);
    }
  }
  return anchors[anchors.length - 1].color;
}

function classifyGapState(gap, expectedGap) {
  if (!Number.isFinite(gap) || !Number.isFinite(expectedGap) || expectedGap <= 0) return "neutral";
  if (gap >= expectedGap * 1.15) return "long";
  if (gap <= expectedGap * 0.85) return "short";
  return "neutral";
}

function buildGapRuns(series, expectedGap) {
  const runs = [];
  series.forEach((gap, idx) => {
    const type = classifyGapState(gap, expectedGap);
    const last = runs[runs.length - 1];
    if (last && last.type === type) {
      last.gaps.push(gap);
      last.end = idx;
    } else {
      runs.push({ type, gaps: [gap], start: idx, end: idx });
    }
  });
  return runs;
}

function computeRecoveryBias(gaps, currentGap, statedP) {
  const expectedGap = statedP > 0 ? 1 / statedP : 0;
  const debtWindow = Math.min(10, gaps.length);
  const debtSlice = debtWindow > 0 ? gaps.slice(-debtWindow) : [];
  const pressureDebt = debtSlice.reduce((sum, gap) => sum + (gap - expectedGap), 0);
  const pressureDebtPct = debtSlice.length ? (pressureDebt / (expectedGap * debtSlice.length)) * 100 : 0;

  const observedSeries = currentGap > 0 ? [...gaps, currentGap] : [...gaps];
  const runs = buildGapRuns(observedSeries, expectedGap);
  const directionalRuns = runs.filter(r => r.type !== "neutral");
  const currentRun = directionalRuns.length ? directionalRuns[directionalRuns.length - 1] : null;
  const previousOppositeRun = currentRun
    ? [...directionalRuns].slice(0, -1).reverse().find(r => r.type !== currentRun.type) || null
    : null;

  let combinedAvg = 0;
  let combinedDeltaPct = 0;
  let twoRunBias = 0;
  if (currentRun && previousOppositeRun) {
    const combined = [...previousOppositeRun.gaps, ...currentRun.gaps];
    combinedAvg = mean(combined);
    combinedDeltaPct = expectedGap > 0 ? ((combinedAvg - expectedGap) / expectedGap) * 100 : 0;
    twoRunBias = clamp(combinedDeltaPct / 100, -1, 1);
  }

  const debtBias = debtSlice.length ? clamp(pressureDebtPct / 100, -1, 1) : 0;
  const runBias = !currentRun ? 0 : currentRun.type === "long"
    ? Math.min(currentRun.gaps.length / 4, 1) * 0.35
    : -Math.min(currentRun.gaps.length / 4, 1) * 0.35;

  const score = (debtSlice.length >= 3 ? debtBias * 0.5 : 0) + (previousOppositeRun ? twoRunBias * 0.35 : 0) + runBias * 0.15;

  let lean = "Neutral";
  let detail = "Mixed recent structure. No strong recovery or pullback lean."; 
  let color = C.dim;
  if (score >= 0.45) {
    lean = "Small-gap recovery lean";
    detail = "Recent underperformance is still elevated. Future gaps may skew shorter than baseline, but not reliably enough to promise an immediate hit.";
    color = C.green;
  } else if (score >= 0.15) {
    lean = "Mild small-gap lean";
    detail = "Recovery bias is present, but modest. Treat this as a favorable context signal, not an entry trigger by itself.";
    color = C.cyan;
  } else if (score <= -0.45) {
    lean = "Huge-gap pullback lean";
    detail = "Recent results have run hot enough that longer gaps are a bit more plausible than usual. This is still only a probabilistic lean.";
    color = C.red;
  } else if (score <= -0.15) {
    lean = "Mild huge-gap lean";
    detail = "Short-gap streak behavior is still dominating. Expect less recovery help than usual unless pressure debt rebuilds.";
    color = C.orange;
  }

  const currentRunLabel = !currentRun
    ? "Neutral / mixed"
    : `${currentRun.type === "long" ? "Long-gap" : "Short-gap"} streak ×${currentRun.gaps.length}`;
  const previousRunLabel = !previousOppositeRun
    ? "Not enough opposite-run history"
    : `${previousOppositeRun.type === "long" ? "Long-gap" : "Short-gap"} streak ×${previousOppositeRun.gaps.length}`;

  return {
    expectedGap,
    debtWindow,
    pressureDebt,
    pressureDebtPct,
    currentRun,
    currentRunLabel,
    previousOppositeRun,
    previousRunLabel,
    combinedAvg,
    combinedDeltaPct,
    score,
    lean,
    detail,
    color,
    shortThreshold: expectedGap * 0.85,
    longThreshold: expectedGap * 1.15,
    ready: gaps.length >= 5,
  };
}

function bayesian(gaps, statedP) {
  if (!gaps.length) return { mean: statedP, low: statedP*0.5, high: statedP*1.5, expectedGap: 1/statedP };
  const total = gaps.reduce((s,v)=>s+v,0), wins = gaps.length;
  const a = 1+wins, b = 1+total-wins, pm = a/(a+b);
  const sd = Math.sqrt((a*b)/((a+b)**2*(a+b+1)));
  return { mean: pm, low: Math.max(0,pm-1.96*sd), high: Math.min(1,pm+1.96*sd), expectedGap: 1/pm };
}

function confidenceIntervals(p, currentGap, lastWin) {
  const log1mp = Math.log(1-p);
  return [
    {label:"25%",target:0.25,color:"#4d8fec"},{label:"50%",target:0.50,color:"#e8b931"},
    {label:"75%",target:0.75,color:"#ed8a36"},{label:"90%",target:0.90,color:"#ec5454"},
    {label:"95%",target:0.95,color:"#c43030"},
  ].map(t => {
    const total = Math.ceil(Math.log(1-t.target)/log1mp);
    return {...t, totalDraws:total, remaining:Math.max(0,total-currentGap), drawNumber:lastWin+total, passed:currentGap>=total};
  });
}

/* ═══ SUPABASE ═══ */
async function sbFetch(table, query = "") {
  const res = await fetch(`${REST}/${table}?${query}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`${table}: ${res.status}`);
  return res.json();
}

async function sbInsert(table, payload, prefer = "") {
  const res = await fetch(`${REST}/${table}`, {
    method: "POST",
    headers: prefer ? { ...HEADERS, Prefer: prefer } : HEADERS,
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 201) {
    throw new Error(`${table} insert failed: ${res.status}`);
  }
  return res;
}


async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

/* ═══ FONTS + PALETTE ═══ */
/*
 * FONT & ANIMATION SETUP
 * For production, move these to your index.html <head>:
 *   <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
 *   <style>
 *     @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
 *     @keyframes goldGlow{0%,100%{box-shadow:0 0 20px rgba(232,185,49,0.12)}50%{box-shadow:0 0 35px rgba(232,185,49,0.22)}}
 *   </style>
 *
 * The code below is a runtime fallback that only runs once.
 */
if (typeof document !== "undefined") {
  if (!document.head.querySelector('link[href*="DM+Sans"]')) {
    const fl = document.createElement("link");
    fl.href = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
    fl.rel = "stylesheet";
    document.head.appendChild(fl);
  }
  if (!document.getElementById('kujiman-anims')) {
    const style = document.createElement('style');
    style.id = 'kujiman-anims';
    style.textContent = `@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}@keyframes goldGlow{0%,100%{box-shadow:0 0 20px rgba(232,185,49,0.12)}50%{box-shadow:0 0 35px rgba(232,185,49,0.22)}}`;
    document.head.appendChild(style);
  }
}

const C = {
  bg:"#08090c",surface:"#101218",surfaceAlt:"#181c25",border:"#252a36",
  text:"#dfe2ea",dim:"#7c8294",muted:"#4e5467",
  gold:"#e8b931",goldGlow:"rgba(232,185,49,0.12)",
  blue:"#4d8fec",green:"#3dca78",red:"#ec5454",purple:"#9b7aed",cyan:"#2ec4d4",orange:"#ed8a36",yellow:"#f2d14c",gray:"#9aa0af",pink:"#e36fa0",
};
const ITEM_COLORS = ["#4d8fec","#3dca78","#ec5454","#9b7aed","#2ec4d4","#ed8a36","#e36fa0","#e8b931","#6ee7b7","#f9a8d4","#93c5fd","#fbbf24","#a5b4fc","#34d399","#fb923c","#f87171","#c084fc","#22d3ee","#a3e635","#fda4af"];
const font = "'DM Sans',sans-serif";
const mono = "'IBM Plex Mono',monospace";
const baseBtn = { border:"none",borderRadius:"6px",fontFamily:font,cursor:"pointer",fontWeight:500,fontSize:"12px",transition:"all 0.15s" };

/* ═══ SHARED STYLE MAP ═══ */
const S = {
  card: { background:C.surface, border:`1px solid ${C.border}`, borderRadius:"10px", padding:"16px", marginBottom:"16px" },
  statBox: { background:C.surfaceAlt, borderRadius:"8px", padding:"12px", border:`1px solid ${C.border}` },
  sectionTitle: { fontSize:"12px", fontWeight:600, color:C.dim, textTransform:"uppercase", letterSpacing:"1px", marginBottom:"10px" },
  label: { fontSize:"10px", color:C.muted, textTransform:"uppercase", letterSpacing:"0.8px", marginBottom:"3px" },
  monoValue: { fontFamily:mono, fontSize:"18px", fontWeight:700 },
  badge: { padding:"3px 8px", borderRadius:"12px", fontSize:"9px", fontWeight:700, letterSpacing:"0.5px", whiteSpace:"nowrap" },
  legendDot: { width:"8px", height:"8px", borderRadius:"999px", display:"inline-block" },
  legendRow: { display:"flex", gap:"14px", flexWrap:"wrap", marginTop:"8px", fontSize:"10px", color:C.muted },
  tabBtn: (active, color = C.gold) => ({ ...baseBtn, padding:"8px 16px", borderRadius:"6px 6px 0 0",
    background: active ? C.surfaceAlt : C.bg, color: active ? color : C.dim,
    borderBottom: active ? `2px solid ${color}` : "2px solid transparent" }),
  alertBanner: (color) => ({ padding:"10px 14px", borderRadius:"8px", background:`${color}10`, border:`1px solid ${color}25` }),
  tooltipBox: { background:C.surfaceAlt, border:`1px solid ${C.border}`, borderRadius:"8px", padding:"8px 12px", fontSize:"11px" },
};

const CTip = ({active,payload,label}) => {
  if (!active||!payload?.length) return null;
  return (<div style={S.tooltipBox}>
    <div style={{color:C.dim,marginBottom:"3px"}}>{label}</div>
    {payload.map((p,i)=>(<div key={i} style={{color:p.color||C.text,fontFamily:mono,fontWeight:600}}>{p.name}: {typeof p.value==="number"?p.value.toLocaleString():p.value}</div>))}
  </div>);
};

/* ═══ MAIN ═══ */
export default function Dashboard() {
  const [events, setEvents] = useState([]);
  const [records, setRecords] = useState([]);
  const [items, setItems] = useState([]);
  const [snapshots, setSnapshots] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedPool, setSelectedPool] = useState(null);
  const [sortBy, setSortBy] = useState("urgency");
  const [filter, setFilter] = useState("");
  const [filterInput, setFilterInput] = useState("");
  const filterTimer = useRef(null);
  const onFilterChange = useCallback((val) => {
    setFilterInput(val);
    clearTimeout(filterTimer.current);
    filterTimer.current = setTimeout(() => setFilter(val), 200);
  }, []);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [detailTab, setDetailTab] = useState("overview");
  const [favorites, setFavorites] = useState(() => {
    try { return JSON.parse(localStorage.getItem("kujiman-favs") || "[]"); } catch { return []; }
  });
  const toggleFav = useCallback((pid, e) => {
    e?.stopPropagation();
    setFavorites(prev => {
      const next = prev.includes(pid) ? prev.filter(id => id !== pid) : [...prev, pid];
      localStorage.setItem("kujiman-favs", JSON.stringify(next));
      return next;
    });
  }, []);

const loadData = useCallback(async () => {
  try {
    setLoading(true);
    const [evts, itms, snaps] = await Promise.all([
      sbFetch("events", "select=*&is_active=eq.true&order=reward_pool_id.desc"),
      sbFetch("items", "select=*&reward_item_type=eq.UR&order=reward_pool_id,reward_item_id"),
      sbFetch("event_snapshots", "select=reward_pool_id,max_num_sort,collected_at&order=collected_at.desc&limit=200"),
    ]);
    // Paginate win_records (Supabase caps at 1000 per request)
    let allRecs = [], offset = 0;
    const PAGE = 1000;
    while (true) {
      const page = await sbFetch("win_records",
        `select=id,reward_pool_id,num_sort,create_time,nickname,reward_item_name,reward_item_id,reward_item_type&reward_item_type=eq.UR&order=reward_pool_id,num_sort.asc&limit=${PAGE}&offset=${offset}`);
      allRecs = allRecs.concat(page || []);
      if (!page || page.length < PAGE) break;
      offset += PAGE;
    }
    setEvents(evts||[]); setRecords(allRecs); setItems(itms||[]);
    const snapMap = {};
    (snaps||[]).forEach(s => { if (!snapMap[s.reward_pool_id]) snapMap[s.reward_pool_id] = s; });
    setSnapshots(snapMap);
    setLastRefresh(new Date());
    setError(null);
  } catch (e) { setError(e.message); }
  setLoading(false);
}, []);

  useEffect(() => { loadData(); }, [loadData]);

  const [liveLoading, setLiveLoading] = useState(false);
  const [liveStatus, setLiveStatus] = useState("");
  const [liveUpdatedPools, setLiveUpdatedPools] = useState([]);

  const liveFetch = useCallback(async () => {
    setLiveLoading(true);
    setLiveStatus("Fetching event list...");
    setLiveUpdatedPools([]);
    try {
      const API = KUJIMAN_API_BASE;
      const ts = () => Math.floor(Date.now() / 1000);
      const EXCLUDE_POOLS = new Set([922, 974, 735]);
      const LIVE_CONCURRENCY = 50;

      const evtRes = await fetch(`${API}/reward_pool_infinite?order_type=3&infinite_type_id=0&sort=0&time=${ts()}&os=4&client_env=h5`);
      const evtJson = await evtRes.json();
      const activeEvts = (evtJson.data?.reward_pool_infinite || []).filter(e => e.status === 1 && !EXCLUDE_POOLS.has(e.id));

      let done = 0;
      const existingIds = new Set(records.map(r => r.id));

      const results = await mapWithConcurrency(activeEvts, LIVE_CONCURRENCY, async (ev) => {
        const startedAt = new Date().toISOString();

        try {
          const [mRes, sRes] = await Promise.all([
            fetch(`${API}/reward_pool_infinite_mowang?reward_pool_id=${ev.id}&append_rank=1&time=${ts()}&os=4&client_env=h5`),
            fetch(`${API}/reward_pool_infinite_item_speed?reward_pool_id=${ev.id}&reward_cur_box_num=1&append_max_num_sort=1&append_item_init=1&append_record=1&record_level=2&list_first_id=9999999999&list_first_item_type=UR&time=${ts()}&os=4&client_env=h5`),
          ]);

          const [mJson, sJson] = await Promise.all([mRes.json(), sRes.json()]);
          const mData = mJson.data?.cur_mowang;
          const sData = sJson.data;

          const snapshotRow = mData?.max_num_sort ? {
            reward_pool_id: ev.id,
            max_num_sort: mData.max_num_sort,
            collected_at: startedAt,
            live: true,
          } : null;

          const listSecond = (sData?.append_record?.list_second || []).filter(r => r.reward_item_type === "UR");
          const listFirst = (sData?.append_record?.list_first || []).filter(r => r.reward_item_type === "UR");

          const seen = new Set();
          const rows = [];
          for (const r of [...listSecond, ...listFirst]) {
            if (!r.id || seen.has(r.id)) continue;
            seen.add(r.id);
            rows.push({
              id: r.id,
              reward_pool_id: ev.id,
              num_sort: r.num_sort,
              create_time: r.create_time || null,
              create_time_parsed: r.create_time ? (() => { try { return new Date(r.create_time.replace(" ", "T") + "+09:00").toISOString(); } catch { return null; } })() : null,
              uid: r.uid ? String(r.uid) : null,
              nickname: r.nickname || null,
              avatar: r.avatar || null,
              reward_item_id: r.reward_item_id || null,
              reward_item_name: r.reward_item_name || null,
              reward_item_type: r.reward_item_type || "UR",
              source: "live_dashboard",
              raw_record: r,
            });
          }

          await Promise.all([
            snapshotRow ? sbInsert("event_snapshots", {
              reward_pool_id: ev.id,
              max_num_sort: mData.max_num_sort,
              raw_meta: { cur_mowang: mData, source: "live_dashboard" },
            }) : Promise.resolve(),
            rows.length ? sbInsert("win_records", rows, "resolution=ignore-duplicates,return=minimal") : Promise.resolve(),
          ]);

          const newRows = [];
          for (const row of rows) {
            if (!existingIds.has(row.id)) {
              existingIds.add(row.id);
              newRows.push(row);
            }
          }

          done += 1;
          setLiveStatus(`⚡ Live fetch ${done}/${activeEvts.length} complete`);

          return {
            ok: true,
            event: ev,
            snapshotRow,
            newRows,
          };
        } catch (error) {
          done += 1;
          setLiveStatus(`⚡ Live fetch ${done}/${activeEvts.length} complete`);
          return { ok: false, event: ev, error };
        }
      });

      const nextSnapshots = { ...snapshots };
      const incomingRows = [];
      const updatedPoolNames = [];

      for (const result of results) {
        if (!result?.ok) continue;
        if (result.snapshotRow) {
          nextSnapshots[result.event.id] = result.snapshotRow;
        }
        if (result.newRows.length > 0) {
          incomingRows.push(...result.newRows);
          updatedPoolNames.push({ name: result.event.reward_pool_name, pid: result.event.id, count: result.newRows.length });
        }
      }

      const totalNewRecs = incomingRows.length;
      setSnapshots(nextSnapshots);
      setLastRefresh(new Date());

      if (incomingRows.length > 0) {
        const merged = [...records, ...incomingRows]
          .sort((a, b) => (a.reward_pool_id - b.reward_pool_id) || (a.num_sort - b.num_sort));
        setRecords(merged);
      }

      setLiveStatus(`✓ Live complete — ${activeEvts.length} events, ${totalNewRecs} new record${totalNewRecs !== 1 ? "s" : ""} saved`);
      setLiveUpdatedPools(updatedPoolNames);
      setTimeout(() => setLiveStatus(""), 8000);
    } catch (e) {
      setLiveStatus(`Error: ${e.message}`);
    }
    setLiveLoading(false);
  }, [snapshots, records]);

  const [singleLiveLoading, setSingleLiveLoading] = useState(false);
  const [singleLiveStatus, setSingleLiveStatus] = useState("");

  const liveFetchSingle = useCallback(async (poolId, poolName) => {
    setSingleLiveLoading(true);
    setSingleLiveStatus(`⚡ Fetching ${poolName}...`);
    try {
      const API = KUJIMAN_API_BASE;
      const ts = () => Math.floor(Date.now() / 1000);
      let newRecs = 0;

      // 1. Mowang → snapshot
      const mRes = await fetch(`${API}/reward_pool_infinite_mowang?reward_pool_id=${poolId}&append_rank=1&time=${ts()}&os=4&client_env=h5`);
      const mData = (await mRes.json()).data?.cur_mowang;
      if (mData?.max_num_sort) {
        const newSnaps = { ...snapshots };
        newSnaps[poolId] = { reward_pool_id: poolId, max_num_sort: mData.max_num_sort, collected_at: new Date().toISOString(), live: true };
        setSnapshots(newSnaps);

        await sbInsert("event_snapshots", {
          reward_pool_id: poolId,
          max_num_sort: mData.max_num_sort,
          raw_meta: { cur_mowang: mData, source: "live_single" },
        });
      }

      await new Promise(r => setTimeout(r, 200));

      // 2. UR win records
      const sRes = await fetch(`${API}/reward_pool_infinite_item_speed?reward_pool_id=${poolId}&reward_cur_box_num=1&append_max_num_sort=1&append_item_init=1&append_record=1&record_level=2&list_first_id=9999999999&list_first_item_type=UR&time=${ts()}&os=4&client_env=h5`);
      const sData = (await sRes.json()).data;

      const listSecond = (sData?.append_record?.list_second || []).filter(r => r.reward_item_type === "UR");
      const listFirst = (sData?.append_record?.list_first || []).filter(r => r.reward_item_type === "UR");
      const seen = new Set();
      const allRecs = [];
      for (const r of [...listSecond, ...listFirst]) {
        if (r.id && !seen.has(r.id)) { seen.add(r.id); allRecs.push(r); }
      }

      if (allRecs.length > 0) {
        const rows = allRecs.map(r => ({
          id: r.id, reward_pool_id: poolId, num_sort: r.num_sort,
          create_time: r.create_time || null,
          create_time_parsed: r.create_time ? (() => { try { return new Date(r.create_time.replace(" ", "T") + "+09:00").toISOString(); } catch { return null; } })() : null,
          uid: r.uid ? String(r.uid) : null, nickname: r.nickname || null, avatar: r.avatar || null,
          reward_item_id: r.reward_item_id || null, reward_item_name: r.reward_item_name || null,
          reward_item_type: r.reward_item_type || "UR", source: "live_single", raw_record: r,
        }));

        await sbInsert(
          "win_records",
          rows,
          "resolution=ignore-duplicates,return=minimal"
        );

        const existingIds = new Set(records.map(r => r.id));
        const newRows = rows.filter(r => !existingIds.has(r.id));
        newRecs = newRows.length;

        // Merge new rows directly instead of re-fetching everything
        if (newRecs > 0) {
          const merged = [...records, ...newRows]
            .sort((a, b) => (a.reward_pool_id - b.reward_pool_id) || (a.num_sort - b.num_sort));
          setRecords(merged);
        }
      }

      const maxInfo = mData?.max_num_sort ? ` · Max: #${mData.max_num_sort.toLocaleString()}` : "";
      setSingleLiveStatus(`✓ ${poolName} updated — ${newRecs} new record${newRecs !== 1 ? "s" : ""}${maxInfo}`);
      setLastRefresh(new Date());
      setTimeout(() => setSingleLiveStatus(""), 6000);
    } catch (err) { setSingleLiveStatus(`Error: ${err.message}`); }
    setSingleLiveLoading(false);
  }, [snapshots, records]);

  /* ═══ ITEMS BY POOL ═══ */
  const itemsByPool = useMemo(() => {
    const m = {};
    items.forEach(it => { if (!m[it.reward_pool_id]) m[it.reward_pool_id] = []; m[it.reward_pool_id].push(it); });
    return m;
  }, [items]);

  /* ═══ COMPUTE ═══ */
  const eventData = useMemo(() => {
    const byPool = {};
    records.forEach(r => { if (!byPool[r.reward_pool_id]) byPool[r.reward_pool_id]=[]; byPool[r.reward_pool_id].push(r); });

    return events.map(ev => {
      const pid = ev.reward_pool_id;
      const recs = (byPool[pid]||[]).sort((a,b) => a.num_sort-b.num_sort);
      const statedP = (Number(ev.ur_rate) || 0.3) / 100;
      const statedGap = Math.round(1 / statedP);
      const price = Number(ev.price) || 0;
      const snap = snapshots[pid];
      const maxNum = snap?.max_num_sort || (recs.length ? recs[recs.length-1].num_sort : 0);
      const lastWin = recs.length ? recs[recs.length-1].num_sort : 0;
      const currentGap = maxNum - lastWin;
      const gaps = [];
      for (let i=1;i<recs.length;i++) gaps.push(recs[i].num_sort - recs[i-1].num_sort);

      const bayes = bayesian(gaps, statedP);
      const cumProb = 1 - Math.pow(1-bayes.mean, currentGap);
      const ci = confidenceIntervals(bayes.mean, currentGap, lastWin);
      const urgency = currentGap / statedGap;
      const avgGap = mean(gaps);

      // Burst Pressure Multi-Gauge: Short (5), Medium (20), Long (100), All
      // Includes current ongoing gap as part of each window
      const burstWindows = [
        { label: "5", sub: "Last 5", n: 5, minReq: 3 },
        { label: "10", sub: "Last 10", n: 10, minReq: 5 },
        { label: "20", sub: "Last 20", n: 20, minReq: 10 },
        { label: "50", sub: "Last 50", n: 50, minReq: 20 },
        { label: "100", sub: "Last 100", n: 100, minReq: 30 },
        { label: "All", sub: `All ${gaps.length + 1}`, n: gaps.length + 1, minReq: 5 },
      ].map(w => {
        // Take last (N-1) completed gaps + current ongoing gap = N entries
        const completedSlice = w.label === "All" ? gaps : gaps.slice(-(w.n - 1));
        const totalEntries = completedSlice.length + 1; // +1 for currentGap
        if (totalEntries < w.minReq) {
          return {
            ...w,
            pressure: 0,
            actual: 0,
            theoretical: 0,
            count: totalEntries,
            active: false,
            targetNum: 0,
            targetGap: 0,
            currentGapInc: currentGap,
            overExpected: 0,
            overExpectedPct: 0,
          };
        }
        const completedSum = completedSlice.reduce((s, v) => s + v, 0);
        const actual = completedSum + currentGap;
        const theoretical = totalEntries / statedP;
        const pressure = theoretical > 0 ? (actual / theoretical) * 100 : 0;
        // Target: draw number where this window hits 100%
        const neededGap = Math.max(0, Math.ceil(theoretical - completedSum));
        const targetNum = lastWin + neededGap;
        const overExpected = Math.max(0, actual - theoretical);
        const overExpectedPct = Math.max(0, pressure - 100);

        return {
          ...w,
          pressure,
          actual,
          theoretical,
          count: totalEntries,
          active: true,
          targetNum,
          targetGap: neededGap,
          currentGapInc: currentGap,
          overExpected,
          overExpectedPct,
        };
      });
      const activeWindows = burstWindows.filter(w => w.active);
      const pressureGaugeMax = Math.max(
        125,
        Math.ceil(
          Math.max(100, ...activeWindows.map(w => w.pressure || 0)) / 25
        ) * 25
      );
      const allInDebt = activeWindows.length >= 2 && activeWindows.every(w => w.pressure >= 100);
      const primaryPressure = (
        burstWindows.find(w => w.active && w.label === "20") ||
        burstWindows.find(w => w.active && w.label === "10") ||
        burstWindows.find(w => w.active)
      )?.pressure || 0;
      const burstPressure = primaryPressure;
      const burstLevel = allInDebt ? "convergence" : burstPressure >= 100 ? "critical" : burstPressure >= 80 ? "high" : burstPressure >= 50 ? "medium" : "low";
      const strategyHint = burstLevel === "convergence" ? "All timeframes overdue — strongest observed signal" : burstLevel === "critical" ? "Primary timeframe overdue — strong statistical signal" : burstLevel === "high" ? "Elevated pressure — approaching favorable range" : "Below threshold — insufficient signal";

      // Drought Streak: consecutive gaps > statedGap from the end
      let droughtStreak = 0;
      if (currentGap > statedGap) droughtStreak++; // current ongoing gap counts
      for (let i = gaps.length - 1; i >= 0; i--) {
        if (gaps[i] > statedGap) droughtStreak++;
        else break;
      }
      const springLoaded = droughtStreak >= 2;

      // Debt Release: detect if a drought streak just ended (recent small gap after big gaps)
      let debtRelease = { active: false, bigStreak: 0, smallStreak: 0, phase: "" };
      if (gaps.length >= 3 && droughtStreak === 0) {
        // Count how many small gaps (< statedGap) are at the end
        let smallCount = 0;
        for (let i = gaps.length - 1; i >= 0; i--) { if (gaps[i] <= statedGap) smallCount++; else break; }
        // Count the big gap streak right before the small ones
        let bigCount = 0;
        for (let i = gaps.length - 1 - smallCount; i >= 0; i--) { if (gaps[i] > statedGap) bigCount++; else break; }
        if (bigCount >= 2 && smallCount >= 1 && smallCount <= 3) {
          debtRelease = { active: true, bigStreak: bigCount, smallStreak: smallCount, phase: smallCount === 1 ? "RELEASING" : smallCount === 2 ? "MID-RELEASE" : "NEARLY DONE" };
        }
      }

      const recoveryBias = computeRecoveryBias(gaps, currentGap, statedP);

      // Item frequency
      const poolItems = itemsByPool[pid] || [];
      const itemWinCounts = {};
      recs.forEach(r => { if (r.reward_item_id) itemWinCounts[r.reward_item_id] = (itemWinCounts[r.reward_item_id]||0)+1; });

      const itemStats = poolItems.map(it => {
        const wins = itemWinCounts[it.reward_item_id] || 0;
        const totalWins = recs.length;
        const expectedPct = totalWins > 0 && poolItems.length > 0 ? 100 / poolItems.length : 0;
        const actualPct = totalWins > 0 ? (wins / totalWins * 100) : 0;
        const luck = expectedPct > 0 ? actualPct / expectedPct : 1;
        return { ...it, wins, totalWins, expectedPct, actualPct, luck };
      }).sort((a,b) => b.wins - a.wins);

      // Items never won (within our data)
      const neverWon = itemStats.filter(i => i.wins === 0);

      // Last won item
      const lastWonItem = recs.length ? recs[recs.length-1] : null;

      const predictions = [
        { method:"Stated (1/p)", value:lastWin+statedGap, gap:statedGap, color:C.blue },
        { method:"Bayesian", value:lastWin+Math.round(bayes.expectedGap), gap:Math.round(bayes.expectedGap), color:C.cyan },
        { method:"Historical Avg", value:lastWin+Math.round(avgGap||statedGap), gap:Math.round(avgGap||statedGap), color:C.green },
      ];
      const consensus = Math.round(mean(predictions.map(p=>p.value)));

      // Hard Pity (max historical drought)
      const hardPity = gaps.length ? Math.max(...gaps) : 0;
      const hardPityPct = hardPity > 0 ? (currentGap / hardPity) * 100 : 0;
      const nearHardPity = hardPityPct >= 90 && gaps.length >= 5;

      // Gap histogram (Sweet Spot) — fixed 20% bands of expected gap
      const bucketSize = Math.max(1, Math.round(statedGap * 0.2));
      const displayMaxRaw = Math.max(currentGap, gaps.length ? Math.max(...gaps) : 0, statedGap * 2.2);
      const displayMax = Math.max(bucketSize, Math.ceil(displayMaxRaw / bucketSize) * bucketSize);
      const gapBuckets = {};
      const outlierCount = 0;
      gaps.forEach(g => {
        const k = Math.floor(g / bucketSize) * bucketSize;
        gapBuckets[k] = (gapBuckets[k] || 0) + 1;
      });
      // Ensure all bins from 0 to displayMax exist (even empty ones for consistent chart)
      for (let b = 0; b < displayMax; b += bucketSize) {
        if (!gapBuckets[b]) gapBuckets[b] = 0;
      }
      const rawGapHistogram = Object.entries(gapBuckets).map(([k, v]) => {
        const rangeStart = +k;
        const rangeMid = rangeStart + bucketSize / 2;
        return {
          range: `${rangeStart.toLocaleString()}~${(rangeStart + bucketSize).toLocaleString()}`,
          rangeStart,
          rangeMid,
          count: v,
          pct: gaps.length > 0 ? (v / gaps.length * 100) : 0,
          fill: getGapGradientColor(rangeMid, statedGap),
          band: getHistoryGapBand(rangeMid, statedGap),
        };
      }).sort((a, b) => a.rangeStart - b.rangeStart);
      
      let runningCount = 0;
      const gapHistogram = rawGapHistogram.map((bin) => {
        runningCount += bin.count;
        return {
          ...bin,
          cumCount: runningCount,
          cumPct: gaps.length > 0 ? (runningCount / gaps.length) * 100 : 0,
        };
      });
      
      const sweetSpot = gapHistogram.length > 0 ? gapHistogram.reduce((best, b) => b.count > best.count ? b : best, gapHistogram[0]) : null;

      const bandTotals = gaps.reduce(
        (acc, g) => {
          const ratio = statedGap > 0 ? g / statedGap : 0;

          if (ratio < 0.8) {
            acc.lt80 += 1;
          } else if (ratio < 1.0) {
            acc.r80to100 += 1;
          } else if (ratio <= 1.2) {
            acc.r100to120 += 1;
          } else {
            acc.gt120 += 1;
          }

          return acc;
        },
        {
          lt80: 0,
          r80to100: 0,
          r100to120: 0,
          gt120: 0,
        }
      );


      // Soft Pity Analyzer: Empirical vs Theoretical (uses same tightened bins)
      const softPityData = gapHistogram.map(bin => {
        const cdfLow = 1 - Math.pow(1 - statedP, bin.rangeStart);
        const cdfHigh = 1 - Math.pow(1 - statedP, bin.rangeStart + bucketSize);
        const theoreticalPct = (cdfHigh - cdfLow) * 100;
        return { ...bin, theoreticalPct: parseFloat(theoreticalPct.toFixed(2)), empiricalPct: parseFloat(bin.pct.toFixed(2)), deviation: parseFloat((bin.pct - theoreticalPct).toFixed(2)) };
      });

      // Rubber-Banding: consecutive gap pairs (N-1 vs N)
      const rubberBandData = gaps.length >= 2 ? gaps.slice(1).map((g, i) => ({
        prevGap: gaps[i],
        curGap: g,
        label: `#${i + 2}`,
      })) : [];

      return { ...ev, pid, recs, statedP, statedGap, price, maxNum, lastWin, currentGap,
        gaps, bayes, cumProb, ci, urgency, avgGap, predictions, consensus,
        itemStats, neverWon, lastWonItem, poolItems,
        hardPity, hardPityPct, nearHardPity, gapHistogram, sweetSpot, bucketSize, bandTotals,
        softPityData, rubberBandData, displayMax, outlierCount,
        burstPressure, burstLevel, strategyHint, burstWindows, allInDebt, pressureGaugeMax,
        droughtStreak, springLoaded, debtRelease, recoveryBias };
    });
  }, [events, records, snapshots, itemsByPool]);

  const sortedEvents = useMemo(() => {
    let filtered = eventData.filter(e => !filter || e.event_name.toLowerCase().includes(filter.toLowerCase()));
    const sorters = { urgency:(a,b)=>b.urgency-a.urgency, name:(a,b)=>a.event_name.localeCompare(b.event_name), cumProb:(a,b)=>b.cumProb-a.cumProb, records:(a,b)=>b.recs.length-a.recs.length, gap:(a,b)=>b.currentGap-a.currentGap, poolDesc:(a,b)=>b.pid-a.pid };
    const baseSorter = sorters[sortBy] || sorters.urgency;
    return [...filtered].sort((a, b) => {
      const aFav = favorites.includes(a.pid) ? 1 : 0;
      const bFav = favorites.includes(b.pid) ? 1 : 0;
      if (aFav !== bFav) return bFav - aFav;
      return baseSorter(a, b);
    });
  }, [eventData, sortBy, filter, favorites]);

  const sel = useMemo(() => eventData.find(e => e.pid === selectedPool), [eventData, selectedPool]);

  const [mainView, setMainView] = useState("events"); // "events" | "bot_radar"

  /* ═══ WHALE / BOT DETECTION ═══ */
  const whaleData = useMemo(() => {
    if (!records.length) return { users: [], globalAvgGap: 0 };
    // Compute global average gap across all events
    let totalGaps = 0, gapCount = 0;
    const byPool = {};
    records.forEach(r => { if (!byPool[r.reward_pool_id]) byPool[r.reward_pool_id] = []; byPool[r.reward_pool_id].push(r); });
    Object.values(byPool).forEach(recs => {
      recs.sort((a, b) => a.num_sort - b.num_sort);
      for (let i = 1; i < recs.length; i++) { totalGaps += recs[i].num_sort - recs[i - 1].num_sort; gapCount++; }
    });
    const globalAvgGap = gapCount > 0 ? totalGaps / gapCount : 0;

    // Group by uid, calculate per-user stats
    const byUser = {};
    records.forEach(r => {
      const uid = r.uid || r.nickname || "unknown";
      if (!byUser[uid]) byUser[uid] = { uid, nickname: r.nickname || uid, wins: [], pools: new Set() };
      byUser[uid].wins.push(r);
      byUser[uid].pools.add(r.reward_pool_id);
    });

    const users = Object.values(byUser).map(u => {
      const totalWins = u.wins.length;
      // Compute the average gap at which this user won (looking at the gap that ended in their win)
      let gapSum = 0, gapN = 0;
      u.wins.forEach(w => {
        const poolRecs = byPool[w.reward_pool_id];
        if (!poolRecs) return;
        const idx = poolRecs.findIndex(r => r.id === w.id);
        if (idx > 0) {
          gapSum += poolRecs[idx].num_sort - poolRecs[idx - 1].num_sort;
          gapN++;
        }
      });
      const avgWinGap = gapN > 0 ? gapSum / gapN : 0;
      const gapRatio = globalAvgGap > 0 ? avgWinGap / globalAvgGap : 1;
      const isSuspicious = totalWins >= 3 && gapRatio <= 0.5;
      return { ...u, totalWins, avgWinGap: Math.round(avgWinGap), poolCount: u.pools.size, gapRatio, isSuspicious };
    }).sort((a, b) => b.totalWins - a.totalWins);

    return { users, globalAvgGap: Math.round(globalAvgGap) };
  }, [records]);

  if (loading) return (
    <div style={{fontFamily:font,background:C.bg,color:C.text,minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:"26px",fontWeight:700,color:C.gold}}>KUJIMAN</div>
        <div style={{color:C.dim,fontSize:"13px",marginTop:"4px"}}>Connecting to Supabase...</div>
      </div>
    </div>
  );

  /* ════════════════════════════════════════════ */
  /* ═══ DETAIL VIEW ═══ */
  /* ════════════════════════════════════════════ */
  if (sel) {
    const e = sel;
    const gapTrend = e.gaps.map((g, i) => ({
      idx: i + 1,
      gap: g,
      avg: Math.round(mean(e.gaps.slice(0, i + 1))),
      expected: e.statedGap,
      lowBand: Math.round(e.statedGap * 0.8),
      highBand: Math.round(e.statedGap * 1.2),
      label: `#${i + 1}`,
      band: getHistoryGapBand(g, e.statedGap),
      fill: getHistoryGapColor(g, e.statedGap),
    }));

    // Item frequency chart data
    const itemChartData = e.itemStats.filter(i => i.wins > 0).map((it, idx) => ({
      name: (it.reward_item_name || "Unknown").replace(/^[^｜]*｜/, "").slice(0, 25),
      fullName: it.reward_item_name || "Unknown",
      wins: it.wins,
      fill: ITEM_COLORS[idx % ITEM_COLORS.length],
    }));
    const visiblePredictions = e.predictions.filter(p => p.method !== "Bayesian");

    const tabs = [
      { id: "overview", label: "Overview" },
      { id: "items", label: `UR Items (${e.poolItems.length})` },
      { id: "history", label: `History (${e.recs.length})` },
    ];

    return (
      <div style={{fontFamily:font,background:C.bg,color:C.text,minHeight:"100vh"}}>
        {/* Header */}
        <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"16px 28px",display:"flex",alignItems:"center",gap:"16px"}}>
          <button onClick={()=>{setSelectedPool(null);setDetailTab("overview");setSingleLiveStatus("");}} style={{...baseBtn,background:C.surfaceAlt,color:C.dim,padding:"8px 14px",border:`1px solid ${C.border}`}}>← Back</button>
          <div style={{flex:1}}>
            <h1 style={{fontSize:"20px",fontWeight:700,color:C.gold,margin:0}}>{e.event_name}</h1>
            <div style={{fontSize:"12px",color:C.dim,marginTop:"2px"}}>Pool {e.pid} · UR {(e.statedP*100).toFixed(2)}% · ₩{e.price?.toLocaleString()}/draw · {e.recs.length} records · {e.poolItems.length} UR items</div>
          </div>
          <button onClick={()=>liveFetchSingle(e.pid, e.event_name)} disabled={singleLiveLoading}
            style={{...baseBtn,background:singleLiveLoading?C.surfaceAlt:C.gold,color:singleLiveLoading?C.dim:"#000",padding:"8px 16px",flexShrink:0}}>
            {singleLiveLoading ? "Fetching..." : "⚡ Live"}
          </button>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:"11px",color:C.dim}}>CONSENSUS</div>
            <div style={{fontSize:"24px",fontWeight:700,fontFamily:mono,color:C.gold}}>#{e.consensus.toLocaleString()}</div>
          </div>
        </div>
        {singleLiveStatus && (
          <div style={{margin:"0 28px",padding:"8px 12px",borderRadius:"0 0 6px 6px",background:`${C.cyan}10`,border:`1px solid ${C.cyan}25`,borderTop:"none",color:C.cyan,fontSize:"12px"}}>
            {singleLiveStatus}
          </div>
        )}

        {/* Tabs */}
        <div style={{padding:"12px 28px 0",display:"flex",gap:"4px",borderBottom:`1px solid ${C.border}`,maxWidth:"1200px",margin:"0 auto"}}>
          {tabs.map(t => (
            <button key={t.id} onClick={()=>setDetailTab(t.id)} style={S.tabBtn(detailTab===t.id)}>{t.label}</button>
          ))}
        </div>

        <div style={{padding:"16px 28px",maxWidth:"1200px",margin:"0 auto"}}>

          {/* ═══ OVERVIEW TAB ═══ */}
          {detailTab === "overview" && (<>
            {/* Stats */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:"10px",marginBottom:"16px"}}>
              {[
                {l:"Current Gap",v:e.currentGap.toLocaleString(),c:e.urgency>1?C.red:C.green},
                {l:"Expected Gap",v:e.statedGap.toLocaleString(),c:C.blue},
                {l:"Max Historical",v:(e.gaps.length?Math.max(...e.gaps):0).toLocaleString(),c:C.dim},
                {l:"Drought Severity",v:`${(e.cumProb*100).toFixed(1)}%`,c:e.cumProb>.9?C.red:e.cumProb>.5?C.orange:C.green,glow:e.cumProb>.9},
                {l:"Drought Streak",v:e.droughtStreak>0?`${"🔥".repeat(Math.min(e.droughtStreak,5))}${e.droughtStreak>5?"+":""}`:"-",c:e.droughtStreak>=3?C.red:e.droughtStreak>=2?C.orange:C.dim,glow:e.droughtStreak>=2},
                {l:"Burst Pressure",v:e.burstPressure>0?`${e.burstPressure.toFixed(1)}%`:"N/A",c:e.burstLevel==="convergence"?C.gold:e.burstLevel==="critical"?C.red:e.burstLevel==="high"?C.orange:C.dim,glow:e.allInDebt},
                {l:"Avg Gap",v:Math.round(e.avgGap||0).toLocaleString(),c:C.green},
              ].map((s,i)=>(
                <div key={i} style={{background:C.surfaceAlt,borderRadius:"8px",padding:"12px",
                  border:`1px solid ${s.glow?s.c+"40":C.border}`,
                  boxShadow:s.glow?`0 0 12px ${s.c}15`:"none"}}>
                  <div style={{...S.label}}>{s.l}</div>
                  <div style={{fontSize:"18px",fontWeight:700,fontFamily:s.l==="Drought Streak"?undefined:mono,color:s.c,
                    ...(s.glow?{textShadow:`0 0 10px ${s.c}40`}:{})}}>{s.v}</div>
                </div>
              ))}
            </div>

            {/* Progress */}
            <div style={S.card}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:"12px",marginBottom:"6px"}}>
                <span style={{fontFamily:mono,color:C.gold,fontWeight:600}}>{e.currentGap.toLocaleString()} draws since last win</span>
                <span style={{color:C.dim}}>#{e.maxNum.toLocaleString()} current · #{e.lastWin.toLocaleString()} last win</span>
              </div>
              <div style={{height:"8px",borderRadius:"4px",background:C.surfaceAlt,overflow:"hidden"}}>
                <div style={{height:"100%",borderRadius:"4px",width:`${Math.min(e.urgency*100,100)}%`,background:e.urgency>1?`linear-gradient(90deg,${C.orange},${C.red})`:`linear-gradient(90deg,${C.green},${C.gold})`}} />
              </div>
              {e.lastWonItem && (
                <div style={{marginTop:"8px",fontSize:"11px",color:C.dim}}>
                  Last UR: <span style={{color:C.text}}>{e.lastWonItem.nickname}</span> won <span style={{color:C.gold}}>{e.lastWonItem.reward_item_name?.replace(/^[^｜]*｜/,"")?.slice(0,40)}</span>
                </div>
              )}
            </div>

            {/* Pressure Multi-Gauge + Strategy */}
            {(e.burstPressure > 0 || e.droughtStreak > 0) && (
              <div style={{background:e.allInDebt?`linear-gradient(135deg,${C.gold}08,${C.surface})`:e.burstLevel==="critical"?`linear-gradient(135deg,${C.red}10,${C.surface})`:C.surface,
                border:`1px solid ${e.allInDebt?C.gold+"40":e.burstLevel==="critical"?C.red+"40":e.burstLevel==="high"?C.orange+"30":C.border}`,
                borderRadius:"10px",padding:"16px",marginBottom:"16px",
                boxShadow:e.allInDebt?`0 0 30px ${C.gold}12`:e.burstLevel==="critical"?`0 0 24px ${C.red}10`:"none"}}>

                {/* Drought Streak Banner */}
                {e.droughtStreak > 0 && (
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"12px",padding:"10px 14px",borderRadius:"8px",
                    background:e.droughtStreak>=3?`${C.red}12`:e.droughtStreak>=2?`${C.orange}10`:C.surfaceAlt,
                    border:`1px solid ${e.droughtStreak>=3?C.red+"25":e.droughtStreak>=2?C.orange+"20":C.border}`}}>
                    <div>
                      <div style={{fontSize:"13px",fontWeight:700,color:e.droughtStreak>=3?C.red:e.droughtStreak>=2?C.orange:C.dim}}>
                        {"🔥".repeat(Math.min(e.droughtStreak, 5))} DROUGHT STREAK x{e.droughtStreak}
                      </div>
                      <div style={{fontSize:"10px",color:C.dim,marginTop:"2px"}}>
                        {e.droughtStreak >= 3 ? "3+ consecutive gaps above expected — elevated statistical pressure" : e.droughtStreak >= 2 ? "2 consecutive droughts — pressure building" : "Current gap exceeds expected"}
                      </div>
                    </div>
                    {e.springLoaded && (
                      <span style={{padding:"4px 10px",borderRadius:"12px",fontSize:"10px",fontWeight:700,letterSpacing:"0.5px",
                        background:`${e.droughtStreak>=3?C.red:C.orange}18`,color:e.droughtStreak>=3?C.red:C.orange,
                        border:`1px solid ${e.droughtStreak>=3?C.red:C.orange}30`,animation:e.droughtStreak>=3?"pulse 1.5s ease-in-out infinite":"none"}}>
                        SPRING LOADED
                      </span>
                    )}
                  </div>
                )}

                {/* Multi-Gauge */}
                <div style={{fontSize:"12px",fontWeight:600,color:e.allInDebt?C.gold:C.dim,textTransform:"uppercase",letterSpacing:"1px",marginBottom:"10px"}}>
                  {e.allInDebt ? "⚡ All timeframes overdue — full convergence detected" : "Pressure multi-gauge"}
                  <span style={{fontSize:"10px",color:C.muted,textTransform:"none",fontWeight:400,marginLeft:"8px"}}>
                    (incl. current gap {e.currentGap.toLocaleString()} · scale 0–{Math.round(e.pressureGaugeMax).toLocaleString()}%)
                  </span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:`repeat(${e.burstWindows.filter(w=>w.active||w.label!=="All").length}, minmax(0, 1fr))`,gap:"10px",marginBottom:"10px",alignItems:"stretch"}}>
                  {e.burstWindows.filter(w => w.active || w.label !== "All").map((w, i) => {
                    const wColor = !w.active ? C.muted : w.pressure >= 100 ? C.red : w.pressure >= 80 ? C.orange : w.pressure >= 50 ? C.gold : C.dim;
                    const gaugeWidth = e.pressureGaugeMax > 0 ? Math.min((w.pressure || 0) / e.pressureGaugeMax * 100, 100) : 0;
                    return (
                      <div key={i} style={{background:C.surfaceAlt,borderRadius:"8px",padding:"10px 12px",minWidth:0,
                        border:`1px solid ${w.pressure>=100?C.red+"30":w.pressure>=80?C.orange+"20":C.border}`}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"4px"}}>
                          <span style={{fontSize:"10px",color:wColor,fontWeight:600,textTransform:"uppercase"}}>{w.label}</span>
                          <span style={{fontSize:"9px",color:C.muted}}>{w.sub} ({w.count})</span>
                        </div>
                        <div style={{fontFamily:mono,fontSize:"20px",fontWeight:700,color:wColor}}>
                          {w.active ? `${w.pressure.toFixed(1)}%` : "—"}
                        </div>
                        {w.active && (
                          <>
                            <div style={{fontSize:"9px",color:C.muted,marginTop:"2px"}}>
                              {Math.round(w.actual).toLocaleString()} / {Math.round(w.theoretical).toLocaleString()}
                            </div>
                            <div style={{height:"4px",borderRadius:"2px",background:C.bg,marginTop:"6px",overflow:"hidden"}}>
                              <div style={{height:"100%",borderRadius:"2px",width:`${gaugeWidth}%`,
                                background:w.pressure>=100?C.red:w.pressure>=80?C.orange:w.pressure>=50?C.gold:`${C.muted}40`}} />
                            </div>
                            {w.pressure < 100 && w.targetNum > 0 && (
                              <div style={{fontSize:"9px",color:C.cyan,marginTop:"4px"}}>
                                100% at: <span style={{fontFamily:mono,fontWeight:600}}>#{w.targetNum.toLocaleString()}</span>
                                <span style={{color:C.muted}}> (+{Math.max(0, w.targetGap - e.currentGap).toLocaleString()} draws)</span>
                              </div>
                            )}
                            {w.pressure >= 100 && (
                              <div style={{fontSize:"9px",color:C.red,marginTop:"4px",fontWeight:600}}>
                                IN DEBT · +{w.overExpectedPct.toFixed(1)}% · +{Math.round(w.overExpected).toLocaleString()} draws over expected
                              </div>
                            )}
                          </>
                        )}
                        {!w.active && <div style={{fontSize:"9px",color:C.muted,marginTop:"2px"}}>Need {w.minReq}+ gaps</div>}
                      </div>
                    );
                  })}
                </div>

                {/* Strategy Banner */}
                <div style={{padding:"10px 14px",borderRadius:"8px",textAlign:"center",
                  background:e.allInDebt?`${C.gold}10`:e.burstLevel==="critical"?`${C.red}08`:e.burstLevel==="high"?`${C.orange}08`:C.surfaceAlt,
                  border:`1px solid ${e.allInDebt?C.gold+"25":e.burstLevel==="critical"?C.red+"20":e.burstLevel==="high"?C.orange+"15":"transparent"}`}}>
                  <div style={{fontSize:"12px",fontWeight:700,letterSpacing:"0.5px",
                    color:e.allInDebt?C.gold:e.burstLevel==="critical"?C.red:e.burstLevel==="high"?C.orange:C.muted,
                    ...(e.allInDebt?{textShadow:`0 0 10px ${C.gold}30`}:{})}}>
                    {e.allInDebt?"✨ ":e.burstLevel==="critical"?"🔥 ":e.burstLevel==="high"?"⚡ ":"⏳ "}
                    SIGNAL: {e.strategyHint}
                  </div>
                  <div style={{fontSize:"9px",color:C.muted,marginTop:"4px"}}>Based on observed gap patterns. Each draw remains independent.</div>
                </div>
              </div>
            )}

            {/* Predictions */}
            <div style={{display:"grid",gridTemplateColumns:`repeat(${visiblePredictions.length},1fr)`,gap:"10px",marginBottom:"16px"}}>
              {visiblePredictions.map((p,i) => (
                <div key={i} style={{background:`linear-gradient(135deg,${p.color}08,${C.surface})`,border:`1px solid ${p.color}25`,borderRadius:"10px",padding:"14px"}}>
                  <div style={{fontSize:"11px",color:p.color,fontWeight:600,marginBottom:"4px"}}>{p.method}</div>
                  <div style={{fontSize:"20px",fontWeight:700,fontFamily:mono}}>#{p.value.toLocaleString()}</div>
                  <div style={{fontSize:"10px",color:C.dim,marginTop:"2px"}}>gap: {p.gap.toLocaleString()}</div>
                  <div style={{height:"4px",borderRadius:"2px",background:C.surfaceAlt,marginTop:"8px",overflow:"hidden"}}>
                    <div style={{height:"100%",borderRadius:"2px",width:`${Math.min(e.currentGap/p.gap*100,100)}%`,background:p.color}} />
                  </div>
                </div>
              ))}
            </div>

            {/* CI */}
            <div style={S.card}>
              <div style={{...S.sectionTitle, marginBottom:"12px"}}>Confidence intervals</div>
              {e.ci.map((c,i)=>{
                const maxD = e.ci[e.ci.length-1].drawNumber * 1.05;
                const curPct = (e.maxNum - e.lastWin) / (maxD - e.lastWin) * 100;
                const bandPct = c.target * 100;
                return (<div key={i} style={{marginBottom:"8px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:"11px",marginBottom:"2px"}}>
                    <span style={{color:c.color,fontWeight:600}}>{c.label}</span>
                    <span style={{fontFamily:mono,color:c.passed?C.red:C.text}}>#{c.drawNumber.toLocaleString()} {c.passed?"✗ PASSED":`+${c.remaining.toLocaleString()} left`}</span>
                  </div>
                  <div style={{position:"relative",height:"14px",background:C.surfaceAlt,borderRadius:"3px",overflow:"hidden"}}>
                    <div style={{position:"absolute",left:0,top:0,height:"100%",width:`${bandPct}%`,background:`linear-gradient(90deg, ${c.color}28, ${c.color}55)`,borderRadius:"3px"}} />
                    <div style={{position:"absolute",left:`${Math.min(curPct,100)}%`,top:0,height:"100%",width:"2px",background:C.gold,zIndex:2}} />
                  </div>
                </div>);
              })}
            </div>

            {/* Charts */}
            {e.gaps.length>0 && (
              <div style={S.card}>
                <div style={{...S.sectionTitle}}>Gap trend</div>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={gapTrend} margin={{top:5,right:5,bottom:5,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="label" tick={{fill:C.muted,fontSize:9}} />
                    <YAxis tick={{fill:C.muted,fontSize:9}} />
                    <Tooltip content={<CTip/>} />
                    <Bar dataKey="gap" radius={[3,3,0,0]} opacity={0.9} name="Gap">
                      {gapTrend.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Bar>
                    <Line type="monotone" dataKey="avg" stroke={C.blue} strokeWidth={2} dot={false} name="Running avg" />
                    <ReferenceLine y={Math.round(e.statedGap * 1.2)} stroke={C.orange} strokeDasharray="4 4" label={{ value: "120%", fill: C.orange, fontSize: 9, position: "insideTopRight" }} />
                    <ReferenceLine y={e.statedGap} stroke={C.blue} strokeDasharray="5 5" label={{ value: "100%", fill: C.blue, fontSize: 9, position: "insideTopRight" }} />
                    <ReferenceLine y={Math.round(e.statedGap * 0.8)} stroke={C.yellow} strokeDasharray="4 4" label={{ value: "80%", fill: C.yellow, fontSize: 9, position: "insideTopRight" }} />
                  </ComposedChart>
                </ResponsiveContainer>
                <div style={{display:"flex",gap:"14px",flexWrap:"wrap",marginTop:"8px",fontSize:"10px",color:C.muted}}>
                  {[
                    ["<80%", C.green],
                    ["80–100%", C.yellow],
                    ["100%", C.gray],
                    ["100–120%", C.orange],
                    [">120%", C.red],
                  ].map(([label, color]) => (
                    <span key={label} style={{display:"inline-flex",alignItems:"center",gap:"6px"}}>
                      <span style={{width:"8px",height:"8px",borderRadius:"999px",background:color,display:"inline-block"}} />
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Sweet Spot Radar */}
            {e.gapHistogram.length > 1 && (
              <div style={{background:C.surface,border:`1px solid ${C.gold}20`,borderRadius:"10px",padding:"16px",marginBottom:"16px"}}>
                <div style={{...S.sectionTitle, marginBottom:"4px"}}>
                  Sweet spot radar — win distribution
                </div>
                <div style={{fontSize:"10px",color:C.muted,marginBottom:"10px"}}>
                  Histogram bins are fixed at 20% of expected gap ({e.bucketSize.toLocaleString()} draws per band).
                </div>
                {e.sweetSpot && (
                  <div style={{fontSize:"12px",color:C.gold,marginBottom:"12px",fontWeight:500}}>
                    Highest probability entry zone: <span style={{fontFamily:mono,fontWeight:700}}>{e.sweetSpot.range}</span> range ({e.sweetSpot.count} wins, {e.sweetSpot.pct.toFixed(1)}%)
                  </div>
                )}
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={e.gapHistogram} margin={{top:5,right:5,bottom:5,left:0}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="range" tick={{fill:C.muted,fontSize:8}} angle={-30} textAnchor="end" height={55} interval={e.gapHistogram.length > 15 ? 1 : 0} />
                    <YAxis tick={{fill:C.muted,fontSize:9}} allowDecimals={false} />
                    <Tooltip content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;

                      return (
                        <div
                          style={{
                            background: C.surfaceAlt,
                            border: `1px solid ${C.border}`,
                            borderRadius: "8px",
                            padding: "8px 12px",
                            fontSize: "11px",
                          }}
                        >
                          <div style={{ color: C.text, fontWeight: 600 }}>
                            Gap {d.range}
                          </div>

                          <div style={{ color: d.fill, fontFamily: mono }}>
                            This band: {d.count} wins ({d.pct.toFixed(1)}%)
                          </div>

                          <div style={{ color: C.gold, fontFamily: mono, marginTop: "2px" }}>
                            Cumulative: {d.cumCount} wins ({d.cumPct.toFixed(1)}%)
                          </div>

                          <div style={{ color: C.dim, marginTop: "2px" }}>
                            {(d.rangeMid / e.statedGap * 100).toFixed(0)}% of expected gap
                          </div>
                        </div>
                      );
                    }} />
                    <Bar dataKey="count" radius={[3,3,0,0]} name="Wins">
                      {e.gapHistogram.map((d,i)=>(
                        <Cell
                          key={i}
                          fill={d.fill}
                          fillOpacity={e.sweetSpot && d.rangeStart===e.sweetSpot.rangeStart ? 1 : 0.78}
                          stroke={e.sweetSpot && d.rangeStart===e.sweetSpot.rangeStart ? C.gold : "transparent"}
                          strokeWidth={e.sweetSpot && d.rangeStart===e.sweetSpot.rangeStart ? 1.5 : 0}
                        />
                      ))}
                    </Bar>
                    {/* Current gap position indicator */}
                    {e.currentGap <= e.displayMax && (() => {
                      const binIdx = e.gapHistogram.findIndex(b => e.currentGap >= b.rangeStart && e.currentGap < b.rangeStart + e.bucketSize);
                      const targetBin = binIdx >= 0 ? e.gapHistogram[binIdx] : null;
                      const markerColor = getHistoryGapColor(e.currentGap, e.statedGap);
                      return targetBin ? (
                        <ReferenceLine
                          x={targetBin.range}
                          stroke={markerColor}
                          strokeWidth={2}
                          strokeDasharray="4 4"
                          label={{value:"YOU",fill:markerColor,fontSize:9,position:"top"}}
                        />
                      ) : null;
                    })()}
                    <ReferenceLine x={e.gapHistogram.find(b => b.rangeStart <= e.statedGap && e.statedGap < b.rangeStart + e.bucketSize)?.range} stroke={C.gray} strokeDasharray="5 5" label={{ value: "EXPECTED", fill: C.blue, fontSize: 9, position: "top" }}/>
                    <ReferenceLine y={0} stroke={C.border} />
                  </ComposedChart>
                </ResponsiveContainer>
                <div style={{display:"flex",gap:"14px",flexWrap:"wrap",marginTop:"8px",fontSize:"10px",color:C.muted}}>
                  {[
                    ["<80%", C.green],
                    ["80–100%", C.yellow],
                    ["100%", C.gray],
                    ["100–120%", C.orange],
                    [">120%", C.red],
                  ].map(([label, color]) => (
                    <span key={label} style={{display:"inline-flex",alignItems:"center",gap:"6px"}}>
                      <span style={{width:"8px",height:"8px",borderRadius:"999px",background:color,display:"inline-block"}} />
                      {label}
                    </span>
                  ))}
                </div>
                
                {/* new totals row */}
                <div
                  style={{
                    display: "flex",
                    gap: "14px",
                    flexWrap: "wrap",
                    marginTop: "6px",
                    fontSize: "10px",
                    color: C.muted,
                  }}
                >
                  {[
                    { label: "<80%", color: C.green, count: e.bandTotals.lt80 },
                    { label: "80–100%", color: C.yellow, count: e.bandTotals.r80to100 },
                    { label: "100–120%", color: C.orange, count: e.bandTotals.r100to120 },
                    { label: ">120%", color: C.red, count: e.bandTotals.gt120 },
                  ].map((item) => (
                    <span
                      key={item.label}
                      style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                    >
                      <span
                        style={{
                          width: "8px",
                          height: "8px",
                          borderRadius: "999px",
                          background: item.color,
                          display: "inline-block",
                        }}
                      />
                      {item.label}:{" "}
                      <span style={{ color: C.text, fontFamily: mono }}>
                        {item.count.toLocaleString()}
                      </span>
                    </span>
                  ))}
                </div>
                

                <div style={{fontSize:"10px",color:C.muted,marginTop:"6px"}}>
                  {e.gapHistogram.length} bins shown. Colored dotted line = your current gap position. Blue dotted line = expected-gap reference band.
                  {e.currentGap > 0 && e.sweetSpot && (
                    <span style={{color: e.currentGap >= e.sweetSpot.rangeStart && e.currentGap < e.sweetSpot.rangeStart + e.bucketSize ? C.green : C.dim}}>
                      {e.currentGap >= e.sweetSpot.rangeStart && e.currentGap < e.sweetSpot.rangeStart + e.bucketSize
                        ? " You are currently IN the sweet spot zone."
                        : e.currentGap < e.sweetSpot.rangeStart
                        ? ` Sweet spot begins in ~${(e.sweetSpot.rangeStart - e.currentGap).toLocaleString()} draws.`
                        : " You have passed the sweet spot — but wins can still occur anytime."}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Rate Monitor */}
            <div style={{...S.card, marginBottom:0}}>
              <div style={{...S.sectionTitle, marginBottom:"12px"}}>Rate monitor</div>

              {/* Rate comparison boxes */}
              {(() => {
                const statedRate = e.statedP;
                const statedGapExp = 1 / statedRate;
                const allTimeRate = e.gaps.length > 0 ? e.gaps.length / e.gaps.reduce((s,v)=>s+v,0) : statedRate;
                const allTimeAvgGap = e.gaps.length > 0 ? mean(e.gaps) : statedGapExp;

                // Rolling windows
                const windows = [
                  { label: "Last 5", n: 5 },
                  { label: "Last 10", n: 10 },
                  { label: "Last 20", n: 20 },
                  { label: "All time", n: e.gaps.length },
                ];

                const windowStats = windows.map(w => {
                  const slice = e.gaps.slice(-w.n);
                  if (slice.length === 0) return { ...w, rate: 0, avgGap: 0, ratio: 0, count: 0 };
                  const avg = mean(slice);
                  const rate = 1 / avg;
                  const ratio = rate / statedRate;
                  return { ...w, rate, avgGap: Math.round(avg), ratio, count: slice.length };
                }).filter(w => w.count >= 3);

                // Trend: is the rate increasing or decreasing recently?
                const recent10 = e.gaps.slice(-10);
                const recent5 = e.gaps.slice(-5);
                const older = e.gaps.length > 10 ? e.gaps.slice(-20, -10) : [];
                const recentAvg = recent10.length > 0 ? mean(recent10) : statedGapExp;
                const olderAvg = older.length > 0 ? mean(older) : statedGapExp;
                const trendDirection = olderAvg > 0 ? (recentAvg - olderAvg) / olderAvg * 100 : 0;

                // Adjusted prediction based on recent rate
                const recentRate = recent10.length >= 3 ? 1 / mean(recent10) : statedRate;
                const blendedRate = e.gaps.length >= 5 ? recentRate * 0.4 + e.bayes.mean * 0.6 : e.bayes.mean;
                const blendedGap = Math.round(1 / blendedRate);

                return (<>
                  {/* Window comparison */}
                  <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.min(windowStats.length + 1, 5)},1fr)`,gap:"10px",marginBottom:"16px"}}>
                    <div style={{background:C.surfaceAlt,borderRadius:"8px",padding:"12px",border:`1px solid ${C.blue}30`}}>
                      <div style={{fontSize:"10px",color:C.blue,fontWeight:600}}>STATED</div>
                      <div style={{fontFamily:mono,fontSize:"16px",fontWeight:700,color:C.blue}}>{(statedRate*100).toFixed(2)}%</div>
                      <div style={{fontSize:"10px",color:C.dim}}>gap: {Math.round(statedGapExp)}</div>
                      <div style={{fontSize:"10px",color:C.muted,marginTop:"2px"}}>baseline</div>
                    </div>
                    {windowStats.map((w, i) => {
                      const isHot = w.ratio > 1.15;
                      const isCold = w.ratio < 0.85;
                      const boxColor = isHot ? C.green : isCold ? C.red : C.text;
                      return (
                        <div key={i} style={{background:C.surfaceAlt,borderRadius:"8px",padding:"12px",border:`1px solid ${isHot?C.green+"30":isCold?C.red+"30":C.border}`}}>
                          <div style={{fontSize:"10px",color:boxColor,fontWeight:600}}>{w.label} ({w.count})</div>
                          <div style={{fontFamily:mono,fontSize:"16px",fontWeight:700,color:boxColor}}>{(w.rate*100).toFixed(2)}%</div>
                          <div style={{fontSize:"10px",color:C.dim}}>gap: {w.avgGap}</div>
                          <div style={{fontSize:"10px",color:boxColor,marginTop:"2px"}}>{w.ratio > 1 ? "+" : ""}{((w.ratio - 1) * 100).toFixed(0)}% vs stated</div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Rolling rate chart */}
                  {e.gaps.length >= 5 && (
                    <div style={{marginBottom:"16px"}}>
                      <div style={{fontSize:"11px",color:C.dim,marginBottom:"8px"}}>Rolling win rate (5-gap window) vs stated rate</div>
                      <ResponsiveContainer width="100%" height={140}>
                        <ComposedChart data={e.gaps.map((g, i) => {
                          const windowSize = 5;
                          const start = Math.max(0, i - windowSize + 1);
                          const slice = e.gaps.slice(start, i + 1);
                          const rollingRate = (1 / mean(slice)) * 100;
                          return { idx: i + 1, label: `#${i + 1}`, rollingRate: parseFloat(rollingRate.toFixed(3)), stated: statedRate * 100 };
                        })} margin={{top:5,right:5,bottom:5,left:5}}>
                          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                          <XAxis dataKey="label" tick={{fill:C.muted,fontSize:9}} />
                          <YAxis tick={{fill:C.muted,fontSize:9}} unit="%" />
                          <Tooltip content={({active,payload,label})=>{
                            if(!active||!payload?.length)return null;
                            return(<div style={S.tooltipBox}>
                              <div style={{color:C.dim}}>{label}</div>
                              <div style={{color:C.purple,fontFamily:mono}}>Rate: {payload[0]?.value?.toFixed(3)}%</div>
                              <div style={{color:C.blue,fontFamily:mono}}>Stated: {(statedRate*100).toFixed(2)}%</div>
                            </div>);
                          }} />
                          <Area type="monotone" dataKey="rollingRate" stroke={C.purple} fill={`${C.purple}15`} strokeWidth={2} name="Rolling rate" />
                          <ReferenceLine y={statedRate * 100} stroke={C.blue} strokeDasharray="5 5" />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {/* Trend */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr",gap:"10px",marginBottom:"12px"}}>
                    <div style={S.statBox}>
                      <div style={{fontSize:"10px",color:C.muted}}>RECENT TREND</div>
                      <div style={{fontSize:"14px",fontWeight:700,color:Math.abs(trendDirection)<10?C.dim:trendDirection>0?C.red:C.green}}>
                        {e.gaps.length < 15 ? "Need more data" : trendDirection > 10 ? "↗ Gaps widening" : trendDirection < -10 ? "↘ Gaps shrinking" : "→ Stable"}
                      </div>
                      {e.gaps.length >= 15 && <div style={{fontSize:"10px",color:C.dim}}>Recent avg {Math.round(recentAvg)} vs prior {Math.round(olderAvg)}</div>}
                    </div>
                  </div>

                  {/* Interpretation */}
                  {e.gaps.length >= 5 && (() => {
                    const r10 = e.gaps.slice(-10);
                    const recentR = r10.length >= 3 ? 1/mean(r10) : statedRate;
                    const recentRatio = recentR / statedRate;
                    return (
                      <div style={{padding:"10px 12px",borderRadius:"8px",fontSize:"11px",lineHeight:1.5,
                        background:recentRatio>1.15?`${C.green}08`:recentRatio<0.85?`${C.red}08`:C.surfaceAlt,
                        border:`1px solid ${recentRatio>1.15?C.green+"25":recentRatio<0.85?C.red+"25":C.border}`,
                        color:recentRatio>1.15?C.green:recentRatio<0.85?C.red:C.dim}}>
                        {recentRatio > 1.15
                          ? `Recent win rate is ${((recentRatio-1)*100).toFixed(0)}% above stated. Wins are coming faster than expected.`
                          : recentRatio < 0.85
                          ? `Recent win rate is ${((1-recentRatio)*100).toFixed(0)}% below stated. Wins are coming slower than expected.`
                          : `Recent win rate is within normal range of stated probability. No significant deviation detected.`
                        }
                        <span style={{color:C.muted,display:"block",marginTop:"4px"}}>Note: Each draw is independent. Rate deviations are descriptive, not guarantees.</span>
                      </div>
                    );
                  })()}
                </>);
              })()}
            </div>

            {/* Recovery Bias Monitor */}
            <div style={{background:C.surface,border:`1px solid ${e.recoveryBias.color}25`,borderRadius:"10px",padding:"16px",marginTop:"16px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:"12px",marginBottom:"12px",flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:"12px",fontWeight:600,color:C.dim,textTransform:"uppercase",letterSpacing:"1px"}}>Recovery bias monitor</div>
                  <div style={{fontSize:"11px",color:C.dim,marginTop:"4px"}}>
                    Event-scaled streak balance using expected gap {Math.round(e.recoveryBias.expectedGap).toLocaleString()} · short &lt; {Math.round(e.recoveryBias.shortThreshold).toLocaleString()} · long &gt; {Math.round(e.recoveryBias.longThreshold).toLocaleString()}
                  </div>
                </div>
                <div style={{padding:"6px 10px",borderRadius:"999px",fontSize:"11px",fontWeight:700,letterSpacing:"0.3px",
                  background:`${e.recoveryBias.color}12`,color:e.recoveryBias.color,border:`1px solid ${e.recoveryBias.color}28`}}>
                  {e.recoveryBias.lean}
                </div>
              </div>

              {e.recoveryBias.ready ? (
                <>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:"10px",marginBottom:"12px"}}>
                    <div style={S.statBox}>
                      <div style={{fontSize:"10px",color:C.muted,textTransform:"uppercase"}}>Pressure debt (last {e.recoveryBias.debtWindow})</div>
                      <div style={{fontFamily:mono,fontSize:"18px",fontWeight:700,color:e.recoveryBias.pressureDebt >= 0 ? C.orange : C.cyan}}>
                        {e.recoveryBias.pressureDebt >= 0 ? "+" : ""}{Math.round(e.recoveryBias.pressureDebt).toLocaleString()}
                      </div>
                      <div style={{fontSize:"10px",color:e.recoveryBias.pressureDebtPct >= 0 ? C.orange : C.cyan,marginTop:"2px"}}>
                        {e.recoveryBias.pressureDebtPct >= 0 ? "+" : ""}{e.recoveryBias.pressureDebtPct.toFixed(1)}% vs expected
                      </div>
                    </div>

                    <div style={S.statBox}>
                      <div style={{fontSize:"10px",color:C.muted,textTransform:"uppercase"}}>Two-run balance</div>
                      <div style={{fontFamily:mono,fontSize:"18px",fontWeight:700,color:e.recoveryBias.previousOppositeRun ? (e.recoveryBias.combinedDeltaPct >= 0 ? C.green : C.red) : C.dim}}>
                        {e.recoveryBias.previousOppositeRun ? `${e.recoveryBias.combinedDeltaPct >= 0 ? "+" : ""}${e.recoveryBias.combinedDeltaPct.toFixed(1)}%` : "N/A"}
                      </div>
                      <div style={{fontSize:"10px",color:C.dim,marginTop:"2px"}}>
                        {e.recoveryBias.previousOppositeRun
                          ? `${e.recoveryBias.previousRunLabel} → ${e.recoveryBias.currentRunLabel}`
                          : e.recoveryBias.currentRunLabel}
                      </div>
                    </div>

                    <div style={S.statBox}>
                      <div style={{fontSize:"10px",color:C.muted,textTransform:"uppercase"}}>Current run state</div>
                      <div style={{fontSize:"18px",fontWeight:700,color:e.recoveryBias.currentRun?.type === "long" ? C.orange : e.recoveryBias.currentRun?.type === "short" ? C.cyan : C.dim}}>
                        {e.recoveryBias.currentRunLabel}
                      </div>
                      <div style={{fontSize:"10px",color:C.dim,marginTop:"2px"}}>
                        Score {e.recoveryBias.score >= 0 ? "+" : ""}{e.recoveryBias.score.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div style={{height:"8px",borderRadius:"999px",background:C.surfaceAlt,overflow:"hidden",marginBottom:"12px",position:"relative"}}>
                    <div style={{position:"absolute",left:"50%",top:0,bottom:0,width:"1px",background:C.border,zIndex:2}} />
                    <div style={{height:"100%",width:`${Math.min(Math.abs(e.recoveryBias.score) * 100, 100)}%`,
                      marginLeft:e.recoveryBias.score >= 0 ? "50%" : `${50 - Math.min(Math.abs(e.recoveryBias.score) * 100, 50)}%`,
                      background:e.recoveryBias.color,borderRadius:"999px",transition:"all 0.2s ease"}} />
                  </div>

                  <div style={{padding:"12px 14px",borderRadius:"8px",background:`${e.recoveryBias.color}08`,border:`1px solid ${e.recoveryBias.color}22`}}>
                    <div style={{fontSize:"13px",fontWeight:700,color:e.recoveryBias.color,marginBottom:"4px"}}>{e.recoveryBias.lean}</div>
                    <div style={{fontSize:"11px",color:C.text,lineHeight:1.55}}>{e.recoveryBias.detail}</div>
                    <div style={{fontSize:"10px",color:C.muted,marginTop:"6px"}}>
                      This blends pressure debt, the latest opposite-run/current-run average, and current streak direction. Use it as context only, not as a deterministic next-win call.
                    </div>
                  </div>
                </>
              ) : (
                <div style={{padding:"12px 14px",borderRadius:"8px",background:C.surfaceAlt,border:`1px solid ${C.border}`,fontSize:"11px",color:C.dim,lineHeight:1.5}}>
                  Need at least 5 completed UR gaps before this monitor becomes meaningful for this event.
                </div>
              )}
            </div>
          </>)}

          {/* ═══ ITEMS TAB ═══ */}
          {detailTab === "items" && (<>
            {/* Item Win Frequency Chart */}
            {itemChartData.length > 0 && (
              <div style={S.card}>
                <div style={{...S.sectionTitle}}>UR item win frequency</div>
                <ResponsiveContainer width="100%" height={Math.max(200, itemChartData.length * 28 + 40)}>
                  <BarChart data={itemChartData} layout="vertical" margin={{top:5,right:30,bottom:5,left:10}}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis type="number" tick={{fill:C.muted,fontSize:10}} allowDecimals={false} />
                    <YAxis type="category" dataKey="name" tick={{fill:C.dim,fontSize:10}} width={180} />
                    <Tooltip content={({active,payload})=>{
                      if(!active||!payload?.length)return null;const d=payload[0].payload;
                      return(<div style={S.tooltipBox}>
                        <div style={{color:C.text,fontWeight:600,marginBottom:"3px"}}>{d.fullName}</div>
                        <div style={{color:C.gold}}>{d.wins} wins</div>
                      </div>);
                    }} />
                    <Bar dataKey="wins" radius={[0,3,3,0]}>
                      {itemChartData.map((d,i)=><Cell key={i} fill={d.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Item Prediction */}
            {e.poolItems.length > 0 && e.recs.length > 0 && (
              <div style={{background:`linear-gradient(135deg,${C.purple}08,${C.surface})`,border:`1px solid ${C.purple}25`,borderRadius:"10px",padding:"16px",marginBottom:"16px"}}>
                <div style={{fontSize:"12px",fontWeight:600,color:C.purple,textTransform:"uppercase",letterSpacing:"1px",marginBottom:"4px"}}>Next item prediction</div>
                <div style={{fontSize:"11px",color:C.dim,marginBottom:"12px"}}>
                  If items are equally likely ({(100/e.poolItems.length).toFixed(1)}% each), items won less often are statistically "due" — though each draw is independent.
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"10px"}}>
                  {e.itemStats.slice(-3).reverse().map((it,i) => (
                    <div key={i} style={{background:C.surfaceAlt,borderRadius:"8px",padding:"12px",border:`1px solid ${i===0?C.purple+"40":C.border}`}}>
                      {it.image_url && <img src={it.image_url} style={{width:"100%",height:"80px",objectFit:"contain",borderRadius:"6px",marginBottom:"8px",background:C.bg}} />}
                      <div style={{fontSize:"11px",color:i===0?C.purple:C.text,fontWeight:600,lineHeight:1.3}}>{(it.reward_item_name||"").replace(/^[^｜]*｜/,"").slice(0,50)}</div>
                      {it.recovery_price > 0 && <div style={{fontSize:"10px",color:C.gold,fontFamily:mono,marginTop:"2px"}}>₩{Math.round(it.recovery_price).toLocaleString()}</div>}
                      <div style={{fontSize:"10px",color:C.dim,marginTop:"4px"}}>{it.wins} wins ({it.actualPct.toFixed(1)}%)</div>
                      <div style={{fontSize:"10px",color:it.luck<0.7?C.green:C.dim}}>
                        {it.wins===0?"Never won yet":it.luck<0.7?"Under-represented":it.luck>1.3?"Over-represented":"Normal"}
                      </div>
                    </div>
                  ))}
                </div>
                {e.neverWon.length > 0 && (
                  <div style={{marginTop:"12px",fontSize:"11px",color:C.green}}>
                    {e.neverWon.length} item(s) never won in our data — may appear next
                  </div>
                )}
              </div>
            )}

            {/* Full Item List */}
            <div style={{...S.card, marginBottom:0}}>
              <div style={{...S.sectionTitle}}>All UR items ({e.poolItems.length})</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:"8px"}}>
                {e.itemStats.map((it,i) => {
                  const isNever = it.wins === 0;
                  const isHot = it.luck > 1.5;
                  const isCold = it.luck < 0.5 && it.wins > 0;
                  return (
                    <div key={i} style={{display:"flex",gap:"10px",padding:"10px",borderRadius:"8px",background:isNever?`${C.green}08`:C.surfaceAlt,border:`1px solid ${isNever?C.green+"30":C.border}`}}>
                      {it.image_url && <img src={it.image_url} style={{width:"48px",height:"48px",objectFit:"contain",borderRadius:"6px",background:C.bg,flexShrink:0}} />}
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                          <div style={{fontSize:"11px",fontWeight:600,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{(it.reward_item_name||"").replace(/^[^｜]*｜/,"")}</div>
                          {it.recovery_price > 0 && <span style={{fontSize:"10px",color:C.gold,fontFamily:mono,flexShrink:0,marginLeft:"6px"}}>₩{Math.round(it.recovery_price).toLocaleString()}</span>}
                        </div>
                        <div style={{fontSize:"10px",color:C.dim,marginTop:"2px"}}>
                          {it.wins} win{it.wins!==1?"s":""} · {it.actualPct.toFixed(1)}%
                          <span style={{marginLeft:"6px",color:isNever?C.green:isHot?C.orange:isCold?C.cyan:C.muted}}>
                            {isNever?"● Never won":isHot?"● Hot":isCold?"● Cold":""}
                          </span>
                        </div>
                        {/* mini bar */}
                        <div style={{height:"3px",borderRadius:"2px",background:C.bg,marginTop:"4px",overflow:"hidden"}}>
                          <div style={{height:"100%",borderRadius:"2px",width:`${Math.min(it.actualPct/Math.max(...e.itemStats.map(x=>x.actualPct||1))*100,100)}%`,background:isNever?C.green:ITEM_COLORS[i%ITEM_COLORS.length]}} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>)}

          {/* ═══ HISTORY TAB ═══ */}
          {detailTab === "history" && (
            <div style={{...S.card, marginBottom:0}}>
              <div style={{...S.sectionTitle}}>UR win history ({e.recs.length})</div>
              <div style={{display:"flex",flexDirection:"column",gap:"2px",maxHeight:"600px",overflowY:"auto"}}>
                <div style={{display:"flex",padding:"6px 10px",fontSize:"10px",color:C.muted,borderBottom:`1px solid ${C.border}`}}>
                  <span style={{minWidth:"70px"}}>#</span>
                  <span style={{flex:1}}>Winner</span>
                  <span style={{flex:2}}>Item</span>
                  <span style={{minWidth:"90px",textAlign:"right"}}>Time</span>
                  <span style={{minWidth:"55px",textAlign:"right"}}>Gap</span>
                </div>
                {[...e.recs].reverse().map((r,i)=>{
                  const gapValue = i < e.gaps.length ? e.gaps[e.gaps.length - 1 - i] : null;
                  const gapColor = getHistoryGapColor(gapValue, e.statedGap);

                  return (
                    <div key={r.id} style={{display:"flex",alignItems:"center",padding:"6px 10px",borderRadius:"4px",background:i===0?C.goldGlow:"transparent",fontSize:"12px"}}>
                      <span style={{fontFamily:mono,fontWeight:600,color:i===0?C.gold:C.text,minWidth:"70px"}}>#{r.num_sort.toLocaleString()}</span>
                      <span style={{color:C.dim,flex:1}}>{r.nickname}</span>
                      <span style={{color:C.dim,flex:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:"11px"}}>{r.reward_item_name?.replace(/^[^｜]*｜/,"")?.slice(0,45)}</span>
                      <span style={{color:C.muted,fontSize:"10px",minWidth:"90px",textAlign:"right"}}>{r.create_time?.slice(5,16)}</span>
                      {gapValue !== null && (
                        <span style={{fontFamily:mono,fontSize:"10px",color:gapColor,minWidth:"55px",textAlign:"right"}}>
                          Δ{gapValue.toLocaleString()}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      </div>
    );
  }

  /* ════════════════════════════════════════════ */
  /* ═══ OVERVIEW ═══ */
  /* ════════════════════════════════════════════ */
  return (
    <div style={{fontFamily:font,background:C.bg,color:C.text,minHeight:"100vh"}}>
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"20px 28px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:"12px"}}>
          <div>
            <h1 style={{fontSize:"22px",fontWeight:700,color:C.gold,margin:0,letterSpacing:"-0.5px"}}>KUJIMAN TRACKER</h1>
            <div style={{fontSize:"12px",color:C.dim,marginTop:"2px"}}>
              {eventData.length} events · {records.length} UR records · {items.length} UR items tracked
              {lastRefresh && <span style={{marginLeft:"12px",color:C.muted}}>Updated {lastRefresh.toLocaleTimeString()}</span>}
            </div>
          </div>
          <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
            <input placeholder="Search events..." value={filterInput} onChange={ev=>onFilterChange(ev.target.value)}
              style={{background:C.surfaceAlt,border:`1px solid ${C.border}`,borderRadius:"6px",padding:"8px 12px",color:C.text,fontSize:"13px",fontFamily:font,outline:"none",width:"180px"}} />
            <select value={sortBy} onChange={ev=>setSortBy(ev.target.value)}
              style={{background:C.surfaceAlt,border:`1px solid ${C.border}`,borderRadius:"6px",padding:"8px 12px",color:C.text,fontSize:"12px",fontFamily:font,outline:"none",cursor:"pointer"}}>
              <option value="urgency">Sort: Urgency</option>
              <option value="cumProb">Sort: Drought Severity</option>
              <option value="records">Sort: Data Volume</option>
              <option value="gap">Sort: Current Gap</option>
              <option value="poolDesc">Sort: Pool Number Descending</option>
              <option value="name">Sort: Name</option>
            </select>
            <button onClick={loadData} style={{...baseBtn,background:C.surfaceAlt,color:C.dim,padding:"8px 16px",border:`1px solid ${C.border}`}}>DB Refresh</button>
            <button onClick={liveFetch} disabled={liveLoading} style={{...baseBtn,background:liveLoading?C.surfaceAlt:C.gold,color:liveLoading?C.dim:"#000",padding:"8px 16px"}}>{liveLoading ? "Fetching..." : "⚡ Live"}</button>
          </div>
        </div>
      </div>

      {error && <div style={{margin:"16px 28px",padding:"12px",borderRadius:"8px",background:`${C.red}15`,border:`1px solid ${C.red}30`,color:C.red,fontSize:"13px"}}>Error: {error}</div>}
      {liveStatus && <div style={{margin:"0 28px 8px",padding:"8px 12px",borderRadius:"6px",background:`${C.cyan}10`,border:`1px solid ${C.cyan}25`,color:C.cyan,fontSize:"12px"}}>
        {liveStatus}
        {liveUpdatedPools.length > 0 && (
          <div style={{marginTop:"4px",fontSize:"11px",color:C.dim}}>
            New records from: {liveUpdatedPools.map(p => <span key={p.pid} style={{color:C.gold,marginRight:"8px"}}>{p.name} (+{p.count})</span>)}
          </div>
        )}
      </div>}

      {/* Main View Tabs */}
      <div style={{padding:"0 28px",display:"flex",gap:"4px",maxWidth:"1200px",margin:"0 auto"}}>
        <button onClick={()=>setMainView("events")} style={S.tabBtn(mainView==="events", C.gold)}>All Events</button>
        <button onClick={()=>setMainView("bot_radar")} style={S.tabBtn(mainView==="bot_radar", C.pink)}>Suspicious User Tracker</button>
      </div>

      <div style={{padding:"20px 28px",maxWidth:"1200px",margin:"0 auto"}}>

        {/* ═══ BOT RADAR VIEW ═══ */}
        {mainView === "bot_radar" && (
          <>
            <div style={{background:C.surface,border:`1px solid ${C.pink}25`,borderRadius:"10px",padding:"16px",marginBottom:"16px"}}>
              <div style={{fontSize:"12px",fontWeight:600,color:C.pink,textTransform:"uppercase",letterSpacing:"1px",marginBottom:"4px"}}>Suspicious user tracker</div>
              <div style={{fontSize:"11px",color:C.dim,marginBottom:"8px"}}>
                Flags users with 3+ UR wins whose average win gap is ≤50% of the global average ({whaleData.globalAvgGap.toLocaleString()} draws).
                These users consistently win with far fewer draws than normal — possible admin bots, or exceptionally lucky whales.
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"10px",marginBottom:"16px"}}>
                <div style={S.statBox}>
                  <div style={{fontSize:"10px",color:C.muted,textTransform:"uppercase"}}>Total users</div>
                  <div style={{fontFamily:mono,fontSize:"18px",fontWeight:700}}>{whaleData.users.length}</div>
                </div>
                <div style={{background:C.surfaceAlt,borderRadius:"8px",padding:"12px",border:`1px solid ${C.red}30`}}>
                  <div style={{fontSize:"10px",color:C.red,textTransform:"uppercase"}}>Flagged suspicious</div>
                  <div style={{fontFamily:mono,fontSize:"18px",fontWeight:700,color:C.red}}>{whaleData.users.filter(u=>u.isSuspicious).length}</div>
                </div>
                <div style={S.statBox}>
                  <div style={{fontSize:"10px",color:C.muted,textTransform:"uppercase"}}>Global avg gap</div>
                  <div style={{fontFamily:mono,fontSize:"18px",fontWeight:700}}>{whaleData.globalAvgGap.toLocaleString()}</div>
                </div>
              </div>
            </div>

            {/* User Table */}
            <div style={{...S.card, marginBottom:0}}>
              <div style={{display:"flex",padding:"8px 12px",fontSize:"10px",color:C.muted,borderBottom:`1px solid ${C.border}`,gap:"8px"}}>
                <span style={{width:"24px"}}></span>
                <span style={{flex:2}}>User</span>
                <span style={{flex:1,textAlign:"right"}}>Total wins</span>
                <span style={{flex:1,textAlign:"right"}}>Events</span>
                <span style={{flex:1,textAlign:"right"}}>Avg win gap</span>
                <span style={{flex:1,textAlign:"right"}}>vs Global avg</span>
                <span style={{flex:1,textAlign:"right"}}>Gap ratio</span>
              </div>
              <div style={{maxHeight:"600px",overflowY:"auto"}}>
                {whaleData.users.filter(u => u.totalWins >= 2).map((u,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",padding:"8px 12px",borderRadius:"4px",gap:"8px",fontSize:"12px",
                    background:u.isSuspicious?`${C.red}08`:"transparent",
                    borderBottom:`1px solid ${C.border}30`}}>
                    <span style={{width:"24px",fontSize:"14px"}}>{u.isSuspicious ? "⚠" : ""}</span>
                    <span style={{flex:2,fontWeight:u.isSuspicious?600:400,color:u.isSuspicious?C.red:C.text}}>{u.nickname}</span>
                    <span style={{flex:1,textAlign:"right",fontFamily:mono,fontWeight:600,color:u.totalWins>=10?C.gold:C.text}}>{u.totalWins}</span>
                    <span style={{flex:1,textAlign:"right",fontFamily:mono,color:C.dim}}>{u.poolCount}</span>
                    <span style={{flex:1,textAlign:"right",fontFamily:mono,color:u.isSuspicious?C.red:C.text}}>{u.avgWinGap > 0 ? u.avgWinGap.toLocaleString() : "N/A"}</span>
                    <span style={{flex:1,textAlign:"right",fontFamily:mono,fontSize:"11px",
                      color:u.gapRatio<=0.5?C.red:u.gapRatio<0.8?C.orange:C.green}}>
                      {u.avgWinGap > 0 ? `${u.gapRatio > 1 ? "+" : ""}${((u.gapRatio - 1) * 100).toFixed(0)}%` : "—"}
                    </span>
                    <span style={{flex:1,textAlign:"right",fontFamily:mono,fontSize:"11px",
                      color:u.gapRatio<=0.5?C.red:u.gapRatio<0.8?C.orange:C.dim}}>
                      {u.avgWinGap > 0 ? `${u.gapRatio.toFixed(2)}x` : "—"}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{marginTop:"12px",fontSize:"10px",color:C.muted}}>
                Showing users with 2+ wins. Red flag = 3+ wins AND avg gap ≤50% of global average.
                This could indicate admin test accounts, bots, or simply very active buyers who purchase in bulk.
              </div>
            </div>
          </>
        )}

        {/* ═══ EVENTS GRID ═══ */}
        {mainView === "events" && (<>

        {/* Task 4: System Debt Alert Banner */}
        {(() => {
          const debtAlerts = sortedEvents.filter(e => e.droughtStreak >= 2 && e.recs.length >= 5);
          return debtAlerts.length > 0 ? (
            <div style={{marginBottom:"16px",display:"flex",flexDirection:"column",gap:"6px"}}>
              {debtAlerts.slice(0, 5).map(e => (
                <div key={e.pid} onClick={()=>{setSelectedPool(e.pid);setDetailTab("overview");}}
                  style={{padding:"10px 16px",borderRadius:"8px",cursor:"pointer",
                    background:e.droughtStreak>=3?`linear-gradient(90deg,${C.red}12,${C.red}06)`:`${C.orange}08`,
                    border:`1px solid ${e.droughtStreak>=3?C.red+"30":C.orange+"25"}`,
                    animation:e.droughtStreak>=3?"pulse 2s ease-in-out infinite":"none"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <span style={{fontSize:"12px",fontWeight:700,color:e.droughtStreak>=3?C.red:C.orange}}>
                        {"🔥".repeat(Math.min(e.droughtStreak,5))} EXTENDED DROUGHT — {e.event_name}
                      </span>
                      <div style={{fontSize:"10px",color:C.dim,marginTop:"2px"}}>
                        Gap has exceeded expected range for {e.droughtStreak} consecutive cycles. Statistical pressure is elevated.
                      </div>
                    </div>
                    <span style={{fontFamily:mono,fontSize:"13px",fontWeight:700,color:e.droughtStreak>=3?C.red:C.orange,whiteSpace:"nowrap",marginLeft:"12px"}}>
                      {e.springLoaded?"SPRING LOADED":"ALERT"} →
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : null;
        })()}

        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))",gap:"12px"}}>
          {sortedEvents.map(e => {
            const uC = e.urgency>1.2?C.red:e.urgency>.7?C.orange:C.green;
            const uL = e.urgency>1.2?"OVERDUE":e.urgency>.7?"APPROACHING":"NORMAL";
            const isFav = favorites.includes(e.pid);
            const cardBorderColor = isFav?C.gold+"60":e.allInDebt?C.gold+"50":e.springLoaded?C.red+"50":e.burstLevel==="critical"?"#ec545460":e.urgency>1?uC+"40":C.border;
            return (
              <div key={e.pid} onClick={()=>{setSelectedPool(e.pid);setDetailTab("overview");}}
                style={{background:C.surface,position:"relative",
                  border:isFav?`2px solid ${C.gold}60`:e.allInDebt?`2px solid ${C.gold}70`:`1px solid ${cardBorderColor}`,
                  borderRadius:"10px",padding:isFav||e.allInDebt?"15px":"16px",cursor:"pointer",transition:"border-color 0.15s",
                  animation:e.allInDebt?"goldGlow 2s ease-in-out infinite":"none",
                  boxShadow:isFav?`0 0 16px ${C.gold}10`:e.allInDebt?`0 0 24px ${C.gold}15`:e.springLoaded?`0 0 20px ${C.red}08`:"none"}}
                onMouseEnter={ev=>ev.currentTarget.style.borderColor=C.gold+"60"}
                onMouseLeave={ev=>ev.currentTarget.style.borderColor=cardBorderColor}>

                {/* Favorite Star */}
                <div onClick={(ev)=>toggleFav(e.pid,ev)}
                  style={{position:"absolute",top:"10px",right:"10px",fontSize:"18px",cursor:"pointer",zIndex:5,
                    color:isFav?C.gold:C.muted,transition:"color 0.15s",lineHeight:1,
                    textShadow:isFav?`0 0 8px ${C.gold}40`:"none"}}
                  onMouseEnter={ev=>{ev.currentTarget.style.color=C.gold;ev.currentTarget.style.transform="scale(1.2)";}}
                  onMouseLeave={ev=>{ev.currentTarget.style.color=isFav?C.gold:C.muted;ev.currentTarget.style.transform="scale(1)";}}>
                  {isFav ? "★" : "☆"}
                </div>

                {/* Top row: name + badges */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"8px",paddingRight:"28px"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:"14px",fontWeight:600,color:C.text,lineHeight:1.3}}>{e.event_name}</div>
                    <div style={{fontSize:"11px",color:C.dim,marginTop:"2px"}}>
                      UR {(e.statedP*100).toFixed(2)}% · ₩{e.price?.toLocaleString()} · {e.recs.length} rec · MAX: {e.hardPity>0?e.hardPity.toLocaleString():"—"}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:"4px",flexShrink:0}}>
                    {e.springLoaded && (
                      <span style={{padding:"3px 8px",borderRadius:"12px",fontSize:"9px",fontWeight:700,letterSpacing:"0.5px",
                        background:`${C.red}18`,color:C.red,border:`1px solid ${C.red}30`,whiteSpace:"nowrap",
                        animation:"pulse 1.5s ease-in-out infinite"}}>SPRING LOADED</span>
                    )}
                    {e.allInDebt && (
                      <span style={{padding:"3px 8px",borderRadius:"12px",fontSize:"9px",fontWeight:700,letterSpacing:"0.5px",
                        background:`${C.gold}18`,color:C.gold,border:`1px solid ${C.gold}30`,whiteSpace:"nowrap"}}>CONVERGENCE</span>
                    )}
                    {!e.springLoaded && !e.allInDebt && (
                      <span style={{padding:"3px 8px",borderRadius:"12px",fontSize:"9px",fontWeight:600,letterSpacing:"0.5px",background:`${uC}15`,color:uC,border:`1px solid ${uC}30`,whiteSpace:"nowrap"}}>{uL}</span>
                    )}
                  </div>
                </div>

                {/* Gap progress + Drought Streak inline */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:"11px",marginBottom:"4px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:"6px"}}>
                    <span style={{fontFamily:mono,color:C.gold,fontWeight:700,fontSize:"14px"}}>{e.currentGap.toLocaleString()}</span>
                    {e.droughtStreak > 0 && (
                      <span style={{fontSize:"13px",lineHeight:1,
                        ...(e.droughtStreak>=3?{animation:"pulse 1s ease-in-out infinite"}:{})}}>
                        {"🔥".repeat(Math.min(e.droughtStreak, 5))}
                      </span>
                    )}
                    {e.springLoaded && (
                      <span style={{fontSize:"8px",fontWeight:700,color:e.droughtStreak>=3?C.red:C.orange,letterSpacing:"0.5px",
                        padding:"1px 5px",borderRadius:"3px",background:`${e.droughtStreak>=3?C.red:C.orange}15`}}>x{e.droughtStreak}</span>
                    )}
                  </div>
                  <span style={{color:C.muted}}>/ {e.statedGap.toLocaleString()} expected</span>
                </div>
                <div style={{height:"5px",borderRadius:"3px",background:C.surfaceAlt,overflow:"hidden",marginBottom:"10px"}}>
                  <div style={{height:"100%",borderRadius:"3px",width:`${Math.min(e.urgency*100,100)}%`,background:e.urgency>1?C.red:C.gold}} />
                </div>
                
                {/* Debt Release Alert */}
                {e.debtRelease.active && (
                  <div style={{padding:"6px 10px",borderRadius:"5px",marginBottom:"8px",textAlign:"center",
                    background:`${C.cyan}10`,border:`1px solid ${C.cyan}25`}}>
                    <div style={{fontSize:"11px",fontWeight:700,color:C.cyan}}>
                      💎 DEBT RELEASE — {e.debtRelease.phase}
                    </div>
                    <div style={{fontSize:"9px",color:C.dim,marginTop:"2px"}}>
                      {e.debtRelease.bigStreak} big gaps → {e.debtRelease.smallStreak} small gap{e.debtRelease.smallStreak>1?"s":""} so far · Recovery window may still be open
                    </div>
                  </div>
                )}

                {/* Pressure Multi-Gauge — Full Card View */}
                {e.burstWindows.some(w => w.active) && (
                  <div style={{marginBottom:"10px",padding:"8px 10px",borderRadius:"6px",
                    background:e.allInDebt?`linear-gradient(135deg,${C.gold}06,${C.surfaceAlt})`:C.surfaceAlt,
                    border:`1px solid ${e.allInDebt?C.gold+"40":e.burstLevel==="critical"?C.red+"30":C.border}`,
                    boxShadow:e.allInDebt?`0 0 16px ${C.gold}18`:"none"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"6px"}}>
                      <span style={{fontSize:"9px",color:e.allInDebt?C.gold:C.muted,textTransform:"uppercase",letterSpacing:"0.4px",fontWeight:600}}>
                        {e.allInDebt?"⚡ Full Convergence":"Pressure Multi-Gauge"}
                      </span>
                      <span style={{fontSize:"8px",color:C.muted}}>0–{Math.round(e.pressureGaugeMax)}%</span>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:"3px"}}>
                      {e.burstWindows.filter(w => w.active || w.label !== "All").map((w, i) => {
                        const wColor = !w.active ? C.muted : w.pressure >= 100 ? C.red : w.pressure >= 80 ? C.orange : w.pressure >= 50 ? C.gold : C.dim;
                        const gaugeWidth = e.pressureGaugeMax > 0 ? Math.min((w.pressure || 0) / e.pressureGaugeMax * 100, 100) : 0;
                        return (
                          <div key={i} style={{display:"flex",alignItems:"center",gap:"6px"}}>
                            <span style={{fontSize:"9px",fontWeight:600,color:wColor,width:"28px",textAlign:"right",flexShrink:0}}>{w.label}</span>
                            <div style={{flex:1,height:"6px",borderRadius:"3px",background:C.bg,overflow:"hidden",position:"relative"}}>
                              {w.active ? (
                                <div style={{height:"100%",borderRadius:"3px",width:`${gaugeWidth}%`,
                                  background:w.pressure>=100?`linear-gradient(90deg,${C.orange},${C.red})`:w.pressure>=80?C.orange:w.pressure>=50?C.gold:`${C.muted}40`,
                                  transition:"width 0.3s ease"}} />
                              ) : (
                                <div style={{height:"100%",borderRadius:"3px",width:"0%",background:`${C.muted}20`}} />
                              )}
                            </div>
                            <span style={{fontSize:"9px",fontFamily:mono,fontWeight:600,color:wColor,width:"42px",textAlign:"right",flexShrink:0}}>
                              {w.active ? `${w.pressure.toFixed(0)}%` : "—"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Bottom stats */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px",marginBottom:"8px"}}>
                  <div>
                    <div style={{fontSize:"11px",color:C.muted,textTransform:"uppercase",fontWeight:500}}>DROUGHT</div>
                    <div style={{fontFamily:mono,fontSize:"14px",fontWeight:600,
                      color:e.cumProb>.9?C.red:e.cumProb>.5?C.orange:C.text,
                      ...(e.cumProb>.9?{textShadow:`0 0 8px ${C.red}40`}:{})}}>{(e.cumProb*100).toFixed(1)}%</div>
                  </div>
                  <div><div style={{fontSize:"11px",color:C.muted,textTransform:"uppercase",fontWeight:500}}>PREDICTED</div><div style={{fontFamily:mono,fontSize:"14px",fontWeight:600,color:C.gold}}>#{e.consensus.toLocaleString()}</div></div>
                </div>

                {/* Strategy Hint */}
                <div style={{fontSize:"10px",fontWeight:600,padding:"5px 8px",borderRadius:"4px",textAlign:"center",
                  background:e.allInDebt?`${C.gold}10`:e.burstLevel==="critical"?`${C.red}12`:e.burstLevel==="high"?`${C.orange}10`:C.surfaceAlt,
                  color:e.allInDebt?C.gold:e.burstLevel==="critical"?C.red:e.burstLevel==="high"?C.orange:C.muted,
                  border:`1px solid ${e.allInDebt?C.gold+"25":e.burstLevel==="critical"?C.red+"25":e.burstLevel==="high"?C.orange+"20":"transparent"}`,
                  ...(e.allInDebt?{textShadow:`0 0 8px ${C.gold}30`}:{})}}>
                  {e.allInDebt?"✨ ":e.burstLevel==="critical"?"🔥 ":e.burstLevel==="high"?"⚡ ":"⏳ "}{e.strategyHint}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{textAlign:"center",padding:"20px",fontSize:"11px",color:C.muted}}>
          Each draw is independent. Predictions are statistical estimates, not guarantees. Data refreshes hourly via collector.
        </div>
        </>)}
      </div>
    </div>
  );
}
