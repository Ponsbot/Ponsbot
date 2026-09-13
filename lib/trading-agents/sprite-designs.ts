/** Hand-authored pixel silhouettes, not executable or user-provided SVG. */
export const spriteDesigns = {
  robot: [".....AAA.....", "......B......", "..BBBBBBBBB..", ".BBAAAAAAABB.", ".BBAEAAAEABB.", ".BBAAAAAAABB.", "..BBBDBBBB...", "....BBB......", "A.BBBBBBB.A..", "A.BBAAABB.A..", "A.BBADABB.A..", "..BBBBBBB....", "...BB.BB.....", "...BB.BB.....", "..DDD.DDD...."],
  wizard: ["......B......", ".....BBB.....", "....BBABB....", "...BBBBBBB...", "..AAAAAAAAA..", "...DDDDDDD...", "...DEDDDED...", "....AAAAA....", ".....AAA.....", "D...BBBBB....", "D..BBABABB...", "D.BBBABABBB..", "D.BBBABABBB..", "D..BBBBBBB...", "D.BBBBBBBBB..", "D.BBBBBBBBB..", "..DD.....DD.."],
  cat: [".BB.......BB.", ".BAB.....BAB.", ".BABB...BBAB.", "..BBBBBBBBB..", "..BAABABAAB..", "..BEABAB AEB..".replace(" ", ""), "..BBBBABBBB..", "...BBDBBB....", "....BBBB.....", "....BBBBB..BB", "...BBAABBB..B", "...BBAABBB..B", "..BBBAABBBBB.", "..BBBBBBBBB..", "..DDD..DDD..."],
  plant: [".....AAA.....", "....AAAAA....", ".....ADA.....", "......B......", "..BBB.B.BBB..", ".BAABB.BBAAB.", "..BBBBBBBBB..", "......B......", "...AAAAAAAA..", "...ABBBBBBA..", "...ABEBBEBA..", "...ABBBBBBA..", "....ABDBBA...", "....AAAAAA...", ".....D..D...."],
  pirate: ["...DDDDDDD...", "..DDDADDDDD..", ".DDDAAADDDDD.", "DDDDDDDDDDDDD", "...AAAAAAA...", "...AEAAADD...", "...AAAADDD...", "....AAAAA....", "..BBBBBBBBB..", ".ABBABBBABBA.", ".ABBABBBABBA.", "..BBABBBABB.D", "..AAAAAAAAA.D", "...BB.BB...DD", "...BB.D......", "..DDD.D......"],
  rover: [".......A.....", ".......B.....", "....BBBBB....", "...BAAAAAB...", "...BAEAEAB...", "...BBBBBBB...", ".BBBBBBBBBBB.", "BBAAAAAAAAABB", "BBBADDDDAABBB", "BBBBBBBBBBBBB", "DDDDDDDDDDDDD", "DADADADADADAD", ".DDDDDDDDDDD."],
  jelly: ["....AAAAA....", "..AAAAAAAAA..", ".AAAAAAAAAAA.", "AABBBBBBBBBAA", "ABBBEBBBEBBBA", "ABBBBBBBBBBBA", "AABBBBDBBBBAA", ".AABBBBBBBAA.", "..AAAAAAAAA..", "...B.B.B.B...", "..BB.B.B.BB..", "..B..B.B..B..", "...B.B.B.B...", "...B..B..B..."],
  bird: [".....BBB.....", "....BBBBB....", "...BBABABB...", "...BBEBEBBAAA", "....BBBBBAA..", "BB..BBBBB....", "BBB.BBAABB...", ".BBBBBAABBB..", "..BBBBAABBBB.", "...BBBAABBB..", "....BBBBBB...", ".....D.D.....", "....AA.AA...."],
  golem: ["....BBBBB....", "...BBBBBBB...", "..BBABBBABB..", "..BBEBBBEBB..", "...BBBBBBB...", "..BBBBDBBBB..", "BBBBBBBBBBBBB", "BABBBAAABBBAB", "BABBBADABBBAB", "BBBBBAAABBBBB", "BBB.BBBBB.BBB", "BBB.BBBBB.BBB", "....BB.BB....", "...BBB.BBB...", "...DDD.DDD..."],
  astronaut: ["....DDDDD....", "..DDAAAAADD..", ".DDAAAAAAADD.", ".DAABBBBBAAD.", ".DABBE BEBBAD.".replace(" ", ""), ".DAABBBBBAAD.", "..DDAAAAADD..", "....DDDDD....", "..AABBBBBAA..", ".AAABBABBAAA.", ".AAABBBBBAAA.", ".AAAABBBAAAA.", "....AA.AA....", "....AA.AA....", "...DDD.DDD..."],
} as const;
export type SpriteArchetype = keyof typeof spriteDesigns;

export function renderSpriteDesign(archetype: SpriteArchetype, seed: number, body: string, accent: string): string {
  const rows = spriteDesigns[archetype];
  const colors: Record<string, string> = { B: body, A: accent, D: "#233c35", E: seed % 3 === 0 ? "#fff5d6" : "#122b30" };
  const width = Math.max(...rows.map(row => row.length));
  const scale = 1.4, left = (25 - width * scale) / 2, top = 28 - rows.length * scale;
  const pixels = rows.flatMap((row, y) => [...row].flatMap((cell, x) => colors[cell]
    ? [`<rect x="${x}" y="${y}" width="1" height="1" fill="${colors[cell]}"/>`] : [])).join("");
  const art = `<g transform="translate(${left} ${top}) scale(${scale})">${pixels}</g>`;
  return seed & 16 ? `<g transform="translate(25 0) scale(-1 1)">${art}</g>` : art;
}
