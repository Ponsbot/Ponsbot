"use client";
import { useEffect, useMemo, useRef } from "react";
import { botDirectionalSprites, facings, type Facing } from "@/lib/trading-agents/directional-sprite";
import { nextWander, wanderPoint, wanderingRandom, walkingFacing } from "@/lib/trading-agents/wander";
import type { BotYardBot } from "@/lib/trading-agents/yard-view";
import styles from "./BotYard.module.css";

export function WanderingBot({ bot, selected, onSelect }: { bot: BotYardBot; selected: boolean; onSelect: () => void }) {
  const root = useRef<HTMLButtonElement>(null), bubble = useRef<HTMLSpanElement>(null);
  const { version, seed, archetype, palette } = bot.sprite;
  const frames = useMemo(() => botDirectionalSprites({ version, seed, archetype, palette }), [version, seed, archetype, palette]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const random = wanderingRandom(seed), media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let point = { x: 15 + random() * 70, y: 28 + random() * 50 }, segment = nextWander(point, random);
    let elapsed = 0, previous = 0, frame = 0, facing: Facing = "s";
    let width = 1, height = 1;
    const resize = new ResizeObserver(entries => { width = entries[0].contentRect.width; height = entries[0].contentRect.height; });
    if (element.parentElement) resize.observe(element.parentElement);
    element.style.left = `${point.x}%`; element.style.top = `${point.y}%`;
    const draw = (time: number) => {
      const delta = previous ? Math.min(time - previous, 100) : 0; previous = time;
      if (!document.hidden && !media.matches && !element.matches(":hover, :focus-visible")) {
        elapsed += delta;
        const walking = elapsed < segment.duration;
        const next = wanderPoint(segment, elapsed / segment.duration);
        facing = walkingFacing((next.x - point.x) * width, (next.y - point.y) * height, facing);
        point = next;
        element.style.left = `${point.x}%`; element.style.top = `${point.y}%`;
        element.dataset.facing = facing; element.dataset.walking = String(walking);
        element.style.zIndex = String(10 + Math.round(point.y));
        if (bubble.current) { bubble.current.hidden = walking || !segment.stop; bubble.current.textContent = segment.stop ? `${segment.stop.icon} ${segment.stop.label}` : ""; }
        if (elapsed >= segment.duration + segment.pause) { segment = nextWander(point, random); elapsed = 0; }
      } else element.dataset.walking = "false";
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); };
  }, [seed]);
  return <button ref={root} type="button" className={`${styles.bot} ${styles.wanderingBot} ${selected ? styles.selected : ""}`} data-facing="s" data-walking="false"
    aria-label={`${bot.name}, view log`} aria-pressed={selected} onClick={onSelect}>
    <span className={styles.botShadow} aria-hidden="true" />
    <span ref={bubble} className={styles.wanderBubble} aria-hidden="true" hidden />
    <span className={styles.directionalSprite} aria-hidden="true">{facings.map(direction =>
      // eslint-disable-next-line @next/next/no-img-element
      <img key={direction} data-direction={direction} src={frames[direction]} width={60} height={72} alt="" draggable={false} />)}</span>
    <span className={styles.nameTag}>{bot.name}</span>
  </button>;
}
