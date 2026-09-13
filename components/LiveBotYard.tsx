"use client";
import { useEffect, useRef, useState } from "react";
import { BotYard } from "./BotYard";
import { MyBotLink } from "./MyBotLink";
import type { BotYardBot } from "@/lib/trading-agents/yard-view";
import { emptyZoneCounts, type YardZone, type ZoneCounts } from "@/lib/trading-agents/yard-zones";

export function LiveBotYard() {
  const [zone, setZone] = useState<YardZone>("center"), [counts, setCounts] = useState(emptyZoneCounts);
  const [bots, setBots] = useState<BotYardBot[]>([]), [selected, setSelected] = useState<string>(), [cursor, setCursor] = useState<string>();
  const [next, setNext] = useState<string | null>(null), [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let active = true, busy = false;
    const controller = new AbortController(), current = ++generation.current;
    async function refresh() {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const list = await fetch(`/api/bot-yard?zone=${zone}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: controller.signal });
        if (!list.ok) throw new Error();
        const page = await list.json() as { bots: BotYardBot[]; nextCursor: string | null };
        const id = selected ?? page.bots[0]?.id;
        if (id && page.bots.some(b => b.id === id)) {
          const detail = await fetch(`/api/bot-yard?selected=${encodeURIComponent(id)}`, { signal: controller.signal });
          if (!detail.ok) throw new Error();
          const response = await detail.json() as { bots: BotYardBot[] };
          page.bots = page.bots.map(b => b.id === id ? response.bots[0] ?? b : b);
        }
        if (active && current === generation.current) { setBots(page.bots); setNext(page.nextCursor); setError(""); }
      } catch { if (active && !controller.signal.aborted) setError("The yard could not be refreshed. Your last view is still here."); }
      finally { busy = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    const visible = () => void refresh(); document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [selected, cursor, zone]);
  const positionIds = bots.map(bot => bot.id).join(",");
  useEffect(() => {
    const controller = new AbortController(); let busy = false;
    async function refreshPositions() {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const response = await fetch(`/api/bot-yard/positions?ids=${encodeURIComponent(positionIds)}`, { signal: controller.signal });
        if (!response.ok) return;
        const { positions: points, counts: latestCounts } = await response.json() as { positions: Array<{ id: string; x: number; y: number; at: number; zone: YardZone }>; counts: ZoneCounts };
        if (!controller.signal.aborted) setCounts(latestCounts);
        if (!controller.signal.aborted) setBots(current => current.map(bot => {
          const point = points.find(p => p.id === bot.id);
          return point && point.at >= (bot.yardPosition?.at ?? 0) ? { ...bot, yardPosition: { x: point.x, y: point.y, at: point.at, zone: point.zone } } : bot;
        }));
      } catch { /* Keep the last canonical position during a transient read failure. */ }
      finally { busy = false; }
    }
    void refreshPositions();
    const timer = setInterval(() => void refreshPositions(), 10000);
    document.addEventListener("visibilitychange", refreshPositions);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", refreshPositions); };
  }, [positionIds]);
  return <><BotYard bots={bots} zone={zone} zoneCounts={counts} onZoneChange={area => { setZone(area); setCursor(undefined); setSelected(undefined); setBots([]); setNext(null); }} onSelect={setSelected} headingAction={<MyBotLink button />} />{error && <p role="status">{error}</p>}
    <nav aria-label="Bot Yard pages">{cursor && <button onClick={() => { setCursor(undefined); setSelected(undefined); }}>First page</button>}
      {next && <button onClick={() => { setCursor(next); setSelected(undefined); }}>Next bots</button>}</nav></>;
}
