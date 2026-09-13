"use client";
import { useEffect, useMemo, useRef } from "react";
import { botDirectionalSprites, facings, type Facing } from "@/lib/trading-agents/directional-sprite";
import { wanderingRandom, walkingFacing } from "@/lib/trading-agents/wander";
import { nearestYardPoint, yardPath, type YardPoint } from "@/lib/trading-agents/yard-navigation";
import { YARD_STOPS } from "@/lib/trading-agents/yard-motion";
import { zoneObjects } from "@/lib/trading-agents/yard-zones";
import type { BotYardBot } from "@/lib/trading-agents/yard-view";
import styles from "./BotYard.module.css";

export function WanderingBot({ bot, selected, onSelect }: { bot: BotYardBot; selected: boolean; onSelect: () => void }) {
  const root = useRef<HTMLButtonElement>(null), bubble = useRef<HTMLSpanElement>(null);
  const canonical = useRef(bot.yardPosition);
  canonical.current = bot.yardPosition;
  const { version, seed, archetype, palette } = bot.sprite;
  const zone = bot.yardPosition?.zone ?? "center";
  const initial = useRef(bot.yardPosition ?? nearestYardPoint({ x: 30 + seed % 40, y: 40 + seed % 20 }, zone)).current;
  const frames = useMemo(() => botDirectionalSprites({ version, seed, archetype, palette }), [version, seed, archetype, palette]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const random = wanderingRandom(seed), media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let point: YardPoint = canonical.current ?? nearestYardPoint({ x: 30 + seed % 40, y: 40 + seed % 20 }, zone);
    let route: YardPoint[] = [], pausedUntil = 0, lastCanonical = 0;
    let previous = 0, frame = 0, facing: Facing = "s";
    let width = 1, height = 1;
    const resize = new ResizeObserver(entries => { width = entries[0].contentRect.width; height = entries[0].contentRect.height; });
    if (element.parentElement) resize.observe(element.parentElement);
    element.style.left = `${point.x}%`; element.style.top = `${point.y}%`;
    const draw = (time: number) => {
      const delta = previous ? Math.min(time - previous, 100) : 0; previous = time;
      if (!document.hidden && !media.matches) {
        const anchor = canonical.current ?? point;
        const far = Math.hypot(anchor.x - point.x, anchor.y - point.y) > 5;
        if (far && canonical.current?.at !== lastCanonical) {
          route = yardPath(point, anchor, zone); pausedUntil = 0; lastCanonical = canonical.current?.at ?? 0;
        }
        if (!route.length && time >= pausedUntil) {
          const goal = far ? anchor : nearestYardPoint({ x: anchor.x + (random() - .5) * 8, y: anchor.y + (random() - .5) * 8 }, zone);
          route = yardPath(point, goal, zone);
        }
        while (route.length && Math.hypot(route[0].x - point.x, route[0].y - point.y) < .05) route.shift();
        const target = route[0], length = target ? Math.hypot(target.x - point.x, target.y - point.y) : 0;
        const distance = Math.min(length, delta * (far ? .0024 : .0012));
        const walking = length > 0;
        const next = target && length ? { x: point.x + (target.x - point.x) * distance / length, y: point.y + (target.y - point.y) * distance / length } : point;
        facing = walkingFacing((next.x - point.x) * width, (next.y - point.y) * height, facing);
        point = next;
        element.style.left = `${point.x}%`; element.style.top = `${point.y}%`;
        element.dataset.facing = facing; element.dataset.walking = String(walking);
        element.style.zIndex = String(10 + Math.round(point.y));
        const places = zone === "center" ? YARD_STOPS : zoneObjects[zone].map(place => ({ ...place, icon: "✦" }));
        const stop = places.find(place => Math.hypot(place.x - point.x, place.y - point.y) < 10);
        if (bubble.current) { bubble.current.hidden = walking || !stop; bubble.current.textContent = stop ? `${stop.icon} ${stop.label}` : ""; }
        if (!walking && !route.length && time >= pausedUntil) pausedUntil = time + 1500 + random() * 2000;
      } else element.dataset.walking = "false";
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); };
  }, [seed, zone]);
  return <button ref={root} type="button" className={`${styles.bot} ${styles.wanderingBot} ${selected ? styles.selected : ""}`} data-facing="s" data-walking="false"
    style={{ left: `${initial.x}%`, top: `${initial.y}%` }} aria-label={`${bot.name}, view log`} aria-pressed={selected} onClick={onSelect}>
    <span className={styles.botShadow} aria-hidden="true" />
    <span ref={bubble} className={styles.wanderBubble} aria-hidden="true" hidden />
    <span className={styles.directionalSprite} aria-hidden="true">{facings.map(direction =>
      // eslint-disable-next-line @next/next/no-img-element
      <img key={direction} data-direction={direction} src={frames[direction]} width={60} height={72} alt="" draggable={false} />)}</span>
    <span className={styles.nameTag}>{bot.name}</span>
  </button>;
}
