import { yardZones, zoneObjects, type YardZone } from "@/lib/trading-agents/yard-zones";
import styles from "./BotYard.module.css";

function Landmark({ kind }: { kind: string }) {
  switch (kind) {
    case "tree": return <><path d="M-16 0L-12-130H14L22 0" fill="#826343"/><g fill="#426c4c"><circle cy="-145" r="67"/><circle cx="-40" cy="-112" r="40"/><circle cx="44" cy="-110" r="44"/></g><circle cx="-23" cy="-161" r="25" fill="#63875b"/></>;
    case "mushroom": return <>{[-44,0,42].map((x,i)=><g key={x} transform={`translate(${x},${i===1?-20:0})`}><path d="M-8 0L-6-30H7L10 0" fill="#eee2c5"/><path d="M-25-24Q0-75 25-24Z" fill="#be6b75"/><circle cy="-36" r="5" fill="#fff0d3"/></g>)}</>;
    case "fire": return <><ellipse rx="45" ry="17" fill="#939483"/><path d="M-32-4L30-22M-30-22L32-4" stroke="#74543d" strokeWidth="12"/><path d="M0-78Q45-24 10-15Q-45-15-13-58Q-10-30 0-78" fill="#dc8949"/><path d="M0-50Q22-20 0-16Q-19-24 0-50" fill="#f4d27a"/></>;
    case "bench": return <><path d="M-58 0V-42M58 0V-42" stroke="#756b54" strokeWidth="12"/><path d="M-74-48H74V-30H-74Z" fill="#b39367"/><path d="M-35-48V-74H-8V-48M20-49L42-76" stroke="#637581" strokeWidth="9"/><circle cx="47" cy="-80" r="12" fill="#a0afb3"/></>;
    case "windmill": return <><path d="M-27 0L-15-118H15L29 0" fill="#b5a27d"/><path d="M0-120L-68-182M0-120L66-180M0-120L65-60M0-120L-65-58" stroke="#faf0d5" strokeWidth="18"/><circle cy="-120" r="13" fill="#6d7c78"/></>;
    case "charger": return <><rect x="-35" y="-95" width="70" height="95" rx="12" fill="#6c8780"/><rect x="-23" y="-81" width="46" height="47" rx="5" fill="#b9dfb3"/><path d="M4-75L-10-54H2L-4-38L15-60H3Z" fill="#4b7751"/><path d="M35-61Q68-65 55-12" fill="none" stroke="#566966" strokeWidth="7"/></>;
    case "water": return <><ellipse cy="-28" rx="119" ry="43" fill="#dcc999"/><ellipse cy="-32" rx="106" ry="34" fill="#76b5bb"/><path d="M-75-33Q-30-47 0-33T76-33M-45-18H30" fill="none" stroke="#bbe3d9" strokeWidth="3"/></>;
    case "castle": return <><path d="M-55 0V-50H-35V-34H35V-50H55V0Z" fill="#c3a471"/><path d="M-63-50L-45-84L-27-50M27-50L45-84L63-50" fill="#e4c38b"/><path d="M-12 0V-22Q0-40 12-22V0" fill="#927951"/><path d="M0-33V-97L29-87L0-75" fill="#b97468" stroke="#88734e" strokeWidth="3"/></>;
    case "hammock": return <><path d="M-68 0L-62-110M68 0L62-110" stroke="#907754" strokeWidth="10"/><path d="M-62-90Q0-30 62-90Q5 0-62-90" fill="#c47d76"/><path d="M-60-85Q0-25 60-85" fill="none" stroke="#f1d1ac" strokeWidth="6"/></>;
    case "dome": return <><path d="M-64 0V-65H64V0Z" fill="#8b89a7"/><path d="M-72-65A72 72 0 0 1 72-65Z" fill="#b9b7d0"/><path d="M-5-66V-121" stroke="#777493" strokeWidth="9"/><path d="M15-65L58-106" stroke="#53566e" strokeWidth="19"/><rect x="-12" y="-32" width="24" height="32" fill="#585974"/></>;
    case "crystals": return <>{[-42,0,40].map((x,i)=><path key={x} d={`M${x-19} -10L${x-17} -${i===1?86:52}L${x} -${i===1?111:73}L${x+19} -${i===1?84:49}L${x+15} -8Z`} fill={i===1?"#8f9fcd":"#ac94c0"} stroke="#d7d5ed" strokeWidth="3"/>)}</>;
    default: return <><ellipse rx="58" ry="21" fill="#8e8ca8"/><ellipse cy="-12" rx="54" ry="19" fill="#dad4df"/><path d="M-20-13L8-68L14-13Z" fill="#787a99"/><path d="M-37-12H37M0-26V2" stroke="#aaa2b8" strokeWidth="2"/></>;
  }
}

export function BotYardZoneScene({ zone }: { zone: Exclude<YardZone,"center"> }) {
  return <><svg className={styles.scenery} style={{zIndex:0}} viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
    <rect width="1000" height="600" fill={yardZones[zone].color}/>
    <path d="M-40 480Q260 370 480 450T1040 390M-40 170Q280 80 520 180T1040 140" fill="none" stroke="#ffffff" strokeOpacity=".14" strokeWidth="75"/>
    {Array.from({length:38},(_,i)=><ellipse key={i} cx={(i*193+37)%1000} cy={(i*137+55)%600} rx="3" ry="2" fill={zone==="west"?"#eee5bc":"#72936c"} opacity=".45"/>)}
  </svg>{zoneObjects[zone].map(object=><svg key={object.kind} className={styles.scenery} style={{zIndex:10+object.y}} viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true"><g transform={`translate(${object.x*10} ${object.y*6})`}><ellipse rx="72" ry="14" fill="#293b34" opacity=".12"/><Landmark kind={object.kind}/><text y="25" textAnchor="middle" fontSize="12" fontFamily="monospace" letterSpacing="1" fill="#40514b">{object.label}</text></g></svg>)}</>;
}
