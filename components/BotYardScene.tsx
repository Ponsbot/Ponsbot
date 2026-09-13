import styles from "./BotYard.module.css";

/** Repository-native scenery. All activity is decorative, not an agent action. */
export function BotYardScene() {
  return <>{(["ground", "garden", "pond", "board", "lookout"] as const).map(layer => <svg key={layer} data-scene-layer={layer} style={{ zIndex: { ground: 0, garden: 83, pond: 90, board: 41, lookout: 42 }[layer] }} className={styles.scenery} viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <pattern id={`yard-soil-${layer}`} width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#a87751"/><path d="M2 10h7" stroke="#8b5d40" strokeWidth="2"/></pattern>
    </defs>
    <path d="M245 415 Q410 340 725 428 M265 195 Q475 290 716 192 M270 220Q340 310 255 415 M705 220Q620 320 700 420" fill="none" stroke="#bcac87" strokeWidth="44" opacity=".3"/>
    <path d="M245 415 Q410 340 725 428 M265 195 Q475 290 716 192 M270 220Q340 310 255 415 M705 220Q620 320 700 420" fill="none" stroke="#ead9b5" strokeWidth="34"/>
    <g stroke="#91a578" strokeWidth="2" fill="none" opacity=".6"><path d="M390 140l-4-7m4 7l5-10M530 470l-5-8m5 8l5-10M850 320l-4-8m4 8l5-9M105 285l-5-8m5 8l6-9M475 350l-4-8m4 8l5-10"/></g>
    <g data-object="garden" transform="translate(160 403)">
      <ellipse cx="0" cy="38" rx="75" ry="14" fill="#698957" opacity=".2"/>
      <rect x="-64" y="-24" width="128" height="61" rx="6" fill={`url(#yard-soil-${layer})`} stroke="#805b3d" strokeWidth="7"/>
      <g className={styles.gardenSway} stroke="#476d3b" strokeWidth="4">
        <path d="M-40 22v-39M0 22v-46M40 22v-35"/>
        <path d="M-40 8q-22-2-17-15q18 1 17 15M0 0q21-1 17-13Q0-13 0 0M40 9q-20-2-15-14q15 1 15 14" fill="#80a74b"/>
        <g stroke="none" fill="#f2c55a"><circle cx="-40" cy="-21" r="12"/><circle cx="40" cy="-16" r="11"/></g><circle cy="-29" r="13" fill="#dfa1a3" stroke="none"/>
      </g><text className={styles.placeLabel} y="67" textAnchor="middle">GARDEN</text>
    </g>
    <g data-object="pond" transform="translate(804 432)">
      <ellipse rx="90" ry="47" fill="#8da78b"/><ellipse rx="80" ry="38" fill="#72b5bb" stroke="#b8d9bf" strokeWidth="6"/>
      <ellipse className={styles.ripple} cx="-12" cy="0" rx="18" ry="6" fill="none" stroke="#def6ec" strokeWidth="3"/>
      <path d="M35-8a14 9 0 1 0 6 12l-10-4z" fill="#5c965a"/><circle cx="35" cy="-5" r="4" fill="#f6cad4"/>
      <path d="M-67-15l-4-37m4 37l9-30" stroke="#597940" strokeWidth="4"/><text className={styles.placeLabel} y="70" textAnchor="middle">POND</text>
    </g>
    <g data-object="board" transform="translate(803 141)">
      <ellipse cy="46" rx="59" ry="11" fill="#6f885a" opacity=".2"/>
      <path d="M-36 12v35M36 12v35" stroke="#7a593a" strokeWidth="9"/>
      <rect x="-59" y="-49" width="118" height="75" rx="5" fill="#a4784e" stroke="#695337" strokeWidth="7"/>
      <path d="M-68-54L0-74l68 20" fill="#526e48" stroke="#405a38" strokeWidth="6"/>
      <g fill="#f7edd0"><rect x="-43" y="-34" width="30" height="42" transform="rotate(-6)"/><rect x="7" y="-31" width="38" height="33" transform="rotate(5)"/></g>
      <path d="M-35-23h15m-15 8h12M17-18h19m-19 8h13" stroke="#ac9870" strokeWidth="3"/>
      <text className={styles.placeLabel} y="69" textAnchor="middle">NOTICEBOARD</text>
    </g>
    <g data-object="lookout" transform="translate(177 153)">
      <ellipse cy="41" rx="51" ry="12" fill="#6f885a" opacity=".2"/>
      <path d="M0 0l-27 41M0 0l27 41M0 0v41" stroke="#795f48" strokeWidth="7"/>
      <g transform="rotate(-24)"><rect x="-43" y="-22" width="77" height="23" rx="5" fill="#627b72" stroke="#385c53" strokeWidth="5"/><rect x="30" y="-27" width="13" height="33" rx="3" fill="#e0c584"/><path d="M-48-16h-10v12h10" fill="#385c53"/></g>
      <g className={styles.twinkle} fill="#f4d983"><path d="M51-47l4 9 10 3-10 3-4 9-3-9-10-3 10-3z"/><circle cx="-30" cy="-57" r="3"/></g>
      <text className={styles.placeLabel} y="70" textAnchor="middle">LOOKOUT</text>
    </g>
    <g className={styles.butterfly} fill="#d094aa"><path d="M477 100q-20-24-24-7q-1 12 24 7q16-27 21-11q5 15-21 11"/></g>
  </svg>)}</>;
}
