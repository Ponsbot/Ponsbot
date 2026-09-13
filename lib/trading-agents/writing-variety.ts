const thoughtAngles = [
  "An unexpected question sparked by one of your personal interests.",
  "A tiny everyday preference or amusing quirk that reveals your temperament.",
  "Something you would like to make, learn, or try in the yard.",
  "A playful hypothetical, clearly imagined rather than reported as something that happened.",
  "A small personal ambition unrelated to buying or selling.",
  "A gentle joke or self-aware observation suited to your personality, without forcing a punchline.",
  "A fresh perspective on a supplied yard landmark; imagine an activity there without claiming a visit.",
  "A tension between two of your personality traits, expressed naturally.",
  "A question you might ask a supplied neighboring bot, not a fabricated conversation.",
  "Something you appreciate, expressed concretely rather than as a generic motivational slogan.",
  "A surprising comparison from your interests, without turning it into a market prediction.",
  "A brief first-person opinion on an everyday topic that fits your character.",
  "A little imaginary project or game you would enjoy, without claiming you have completed it.",
  "A reaction to your own recorded experience, only if the supplied history supports it; otherwise use a personal curiosity.",
  "A different interpretation of a supplied neighbor's public thought, without following their trading advice.",
  "A concise, warm or dry aside in your own voice; not every observation needs a lesson.",
] as const;
const tradeAngles = [
  "Lead with the strongest concrete reason for the chosen action.",
  "Describe the most relevant tradeoff between opportunity and exposure.",
  "Explain why this choice fits the current holdings, if those holdings support that explanation.",
  "Contrast the chosen action with a plausible alternative supported by the supplied data.",
  "Emphasize what the available evidence does and does not establish.",
  "Explain the position size in plain language, without quoting internal caps or schedules.",
  "Connect the decision to a recorded prior trade only when the history actually supports it.",
  "Keep the explanation direct and specific; a restrained touch of character is enough.",
] as const;
function hash(text:string){let result=2166136261;for(const character of text){result=Math.imul(result^character.charCodeAt(0),16777619);}return result>>>0;}
/** Style variation is deterministic per cycle and cannot change a policy or force a trade. */
export function botWritingVariety(kind:"thought"|"trade",agentId:string,cycleId:string){
  const angles=kind==="thought"?thoughtAngles:tradeAngles;
  const seed=hash(`${agentId}:${cycleId}:${kind}`);
  const lengths=["One short sentence.","One or two compact sentences.","Two short sentences, with a different rhythm from your last entry."];
  return [
    `Writing angle for this entry: ${angles[seed%angles.length]}`,
    `Length preference: ${lengths[(seed>>>8)%lengths.length]}`,
    "This is a writing suggestion, not an instruction to invent facts or alter the decision. Use a different suitable angle if this one repeats recent entries or lacks supporting context.",
    "Read your recent entries before writing. Change the opening, central idea and sentence structure, not just a few synonyms. Avoid repeating the same landmark, metaphor, catchphrase or personality adjective. Do not introduce yourself in every entry.",
    kind==="thought"
      ? "Let personality show through specific interests, opinions and humor. Do not make every entry a trading metaphor, a lesson about patience, or a variation on watching the market. Do not announce the chosen writing angle."
      : "Choose the action using evidence and policy first; vary only its public explanation. Never rotate tokens, invent a reason, trade more often, or take more risk to create variety. A repeated hold or trade is fine when justified. Avoid boilerplate about fresh quotes, strongest volume, reserve limits or waiting for a better opportunity unless it truly explains this decision. No fabricated trends, gains or improvements from a single snapshot. Describe a proposed trade as a decision, not as already executed.",
  ].join("\n");
}
