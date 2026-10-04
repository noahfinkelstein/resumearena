// Vendored English profanity / slur blocklist for handles, after the LDNOOBW list with the owner's
// additions, condensed to single tokens. Reviewed like code; nothing is fetched at runtime.
//
// Two match modes keep Scunthorpe-style false positives down:
//   STRONG  — unambiguous terms matched as substrings of the folded handle;
//   EXACT   — short or ambiguous terms (ass, cum, dick, paki, rapist, …) matched only against a whole
//             hyphen-separated segment or the whole folded handle.
// Folding: lowercase, hyphens removed, leetspeak digits mapped to letters, 3+ repeated letters
// squeezed to two. A second variant simply drops digits so `ass123` still reads as `ass`.

const STRONG_WORDS = [
  // sexual / profane
  'fuck', 'fukk', 'fvck', 'phuk', 'phuck', 'fcuk', 'fucker', 'fucking', 'motherfucker', 'muthafucka',
  'shit', 'shite', 'bullshit', 'horseshit', 'dipshit', 'shithead', 'shitface', 'shitbag', 'shitter', 'shitty',
  'asshole', 'arsehole', 'assfuck', 'buttfuck', 'asswipe', 'asslick', 'asshat', 'assclown', 'dumbass', 'jackass', 'fatass', 'lardass',
  'bitch', 'biatch', 'bitches', 'bastard', 'cunt', 'cunts', 'twat', 'twats', 'bellend', 'knobhead', 'knobend', 'bollock', 'bollocks',
  'wanker', 'tosser', 'douche', 'douchebag', 'scumbag', 'dickhead', 'dickface', 'dickwad', 'dickweed', 'dickbag',
  'cocksuck', 'cocksucker', 'cockhead', 'cockface', 'cockmunch', 'cockmongler', 'cockbite',
  'pussy', 'pussies', 'pusy', 'punani', 'punanny', 'coochie', 'cooch', 'minge', 'vajayjay', 'vagina', 'vulva', 'clitoris', 'clit',
  'penis', 'phallus', 'schlong', 'boner', 'ballsack', 'nutsack', 'scrotum', 'testicle', 'testicles', 'gonad',
  'boob', 'boobs', 'boobies', 'titty', 'titties', 'nipple', 'nipples', 'areola',
  'blowjob', 'handjob', 'footjob', 'rimjob', 'rimming', 'titfuck', 'titjob', 'deepthroat', 'facefuck', 'skullfuck',
  'cumshot', 'cumslut', 'cumdump', 'cumbucket', 'cumguzzl', 'cumface', 'jizz', 'jism', 'bukkake', 'creampie', 'gangbang',
  'orgasm', 'fellatio', 'cunnilingus', 'analingus', 'sodomy', 'sodomize', 'sodomise', 'buggery', 'bareback', 'gloryhole', 'dogging', 'felch', 'felching', 'fisting',
  'dildo', 'dildos', 'buttplug', 'fleshlight', 'vibrator', 'strapon', 'cockring',
  'porno', 'pornography', 'hentai', 'xvideos', 'pornhub', 'xhamster', 'redtube', 'onlyfans', 'camgirl', 'camwhore',
  'whore', 'whores', 'slut', 'sluts', 'slutty', 'skank', 'skanky', 'prostitute', 'pimping',
  'masturbat', 'jerkoff', 'jackoff', 'wankoff', 'fapping', 'nudes', 'upskirt', 'erotica', 'bdsm', 'bondage',
  'smegma', 'queef',
  'pedophile', 'paedophile', 'pedophilia', 'paedophilia', 'lolicon', 'shotacon', 'childporn', 'kiddieporn',
  'molest', 'molester', 'molesting', 'incest', 'bestiality', 'beastiality', 'zoophilia', 'necrophilia',
  'piss', 'pisser', 'pissflaps', 'poop', 'poopchute', 'dingleberry',
  // slurs: race, ethnicity, religion
  'nigger', 'niggers', 'nigga', 'niggas', 'niggaz', 'nigguh', 'niglet', 'nignog', 'negro', 'negroes', 'negress', 'darkie', 'darkey', 'darky',
  'jigaboo', 'jiggaboo', 'pickaninny', 'porchmonkey', 'spearchucker', 'junglebunny', 'tarbaby', 'mammy',
  'chink', 'chinks', 'chinaman', 'chinamen', 'chingchong', 'gook', 'gooks', 'slopehead', 'zipperhead', 'slanteye',
  'wetback', 'wetbacks', 'beaner', 'beaners', 'spics', 'spick', 'greaser', 'greaseball', 'tacobender',
  'kike', 'kikes', 'kyke', 'hymie', 'sheeny', 'christkiller', 'yids',
  'raghead', 'towelhead', 'cameljockey', 'sandnigger', 'sandnigga', 'dunecoon', 'mudslime', 'muzzie', 'muzzies',
  'currymuncher', 'dothead',
  'redskin', 'redskins', 'injun', 'prairienigger', 'timbernigger',
  'polack', 'polacks', 'honky', 'honkey', 'honkies', 'cracka', 'whitetrash', 'trailertrash',
  'gyppo', 'gippo', 'pikey', 'pikeys', 'boong', 'boongs', 'coolie', 'coolies', 'hottentot',
  // slurs: orientation, gender, disability
  'faggot', 'faggots', 'fagot', 'faggy', 'poofter', 'poofs', 'battyboy', 'battyman', 'fudgepacker', 'carpetmuncher', 'rugmuncher',
  'bulldyke', 'lezzie', 'lesbo', 'tranny', 'trannies', 'shemale', 'shemales', 'ladyboy', 'heshe',
  'retard', 'retards', 'retarded', 'libtard', 'fucktard', 'asstard', 'conservatard', 'tards', 'mongoloid', 'spastic', 'spazz',
  'midget', 'midgets',
  'cuckold', 'cucks', 'incel', 'incels', 'soyboy',
  // hate / violence
  'nazi', 'nazis', 'neonazi', 'hitler', 'adolfhitler', 'heilhitler', 'siegheil', 'swastika', 'whitepower', 'whitepride', 'kukluxklan', 'klansman',
  'holohoax', 'gasthejews', 'killjews', 'killallblacks', 'lynching', 'lynchmob', 'jihadi', 'alqaeda', 'alqaida', 'terrorist',
  // drugs
  'cocaine', 'crackhead', 'methhead', 'tweaker',
] as const;

const EXACT_WORDS = [
  'ass', 'arse', 'anal', 'anus', 'cum', 'cums', 'dick', 'dicks', 'cock', 'cocks', 'tit', 'tits', 'sex', 'sexy', 'xxx', 'nude', 'naked',
  'crap', 'turd', 'fart', 'damn', 'hell', 'prick', 'knob', 'muff', 'hoe', 'hoes', 'ho', 'pimp', 'vag', 'poon', 'snatch',
  'rape', 'raped', 'rapes', 'rapist', 'raping', 'pedo', 'pedos', 'paedo', 'porn', 'spunk', 'orgy', 'smut', 'pube', 'pubes', 'fap', 'wank', 'mofo',
  'hooker', 'thot', 'milf', 'dilf', 'gilf',
  'fag', 'fags', 'dyke', 'dykes', 'homo', 'homos', 'queer', 'poof', 'tard', 'mong', 'spaz', 'sperg', 'spergs', 'cuck', 'simp',
  'coon', 'coons', 'paki', 'jap', 'japs', 'nip', 'nips', 'spic', 'spik', 'gyp', 'wog', 'wogs', 'wop', 'wops', 'dago', 'dagos', 'kraut', 'yid', 'heeb',
  'abo', 'abos', 'abbo', 'lebo', 'spook', 'whitey', 'ching', 'chong', 'sambo', 'squaw', 'kafir', 'kaffir', 'isis',
  'nig', 'nigs', 'nigg', 'negr', 'kkk', '1488', 'heil', 'ss88',
  'meth', 'weed', 'heroin', 'fuk', 'fuks', 'fuc', 'fck', 'fkn', 'fuckin', 'sh1t', 'shyt', 'sht',
] as const;

/** Innocent words that contain a STRONG entry as a substring; stripped before matching. */
const ALLOW_SUBSTRINGS = ['scunthorpe', 'ashkenazi', 'montenegro', 'penistone', 'clitheroe', 'shita', 'phuket', 'lightwater', 'nippon', 'dickens', 'dickinson', 'dickson'];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '+': 't' };

const squeeze = (s: string): string => s.replace(/(.)\1{2,}/g, '$1$1');
/** Every run collapsed to one character: `fuuuuck` → `fuck`. Only compared with entries that have no doubled letters, so `bobs` never reads as `boobs`. */
const collapse = (s: string): string => s.replace(/(.)\1+/g, '$1');
const hasNoDoubles = (w: string): boolean => collapse(w) === w;

/** lowercase, hyphens gone, leetspeak digits as letters, long repeats squeezed. */
export function foldHandle(s: string): string {
  const lower = s.toLowerCase().replace(/-/g, '');
  let out = '';
  for (const ch of lower) out += LEET[ch] ?? ch;
  return squeeze(out);
}

const STRONG: ReadonlySet<string> = new Set(STRONG_WORDS);
const EXACT: ReadonlySet<string> = new Set(EXACT_WORDS);
const STRONG_SINGLE: ReadonlySet<string> = new Set(STRONG_WORDS.filter(hasNoDoubles));
const EXACT_SINGLE: ReadonlySet<string> = new Set(EXACT_WORDS.filter(hasNoDoubles));
export const BLOCKLIST: ReadonlySet<string> = new Set([...STRONG, ...EXACT]);

function stripAllowed(s: string): string {
  let out = s;
  for (const w of ALLOW_SUBSTRINGS) if (out.includes(w)) out = out.split(w).join('');
  return out;
}

function containsStrong(s: string): boolean {
  const t = stripAllowed(s);
  for (const w of STRONG) if (t.includes(w)) return true;
  const c = stripAllowed(collapse(s));
  for (const w of STRONG_SINGLE) if (c.includes(w)) return true;
  return false;
}

const isExact = (s: string): boolean => EXACT.has(s) || EXACT_SINGLE.has(collapse(s));

/** Variants of one string that all stand for what the reader sees. */
function variants(s: string): string[] {
  const lower = s.toLowerCase();
  const noHyphen = lower.replace(/-/g, '');
  const out = new Set<string>([noHyphen, squeeze(noHyphen), foldHandle(s), squeeze(noHyphen.replace(/\d+/g, ''))]);
  out.delete('');
  return [...out];
}

/** True when the handle, any hyphen-separated segment, or a leet-folded form reads as a blocked word. */
export function isBlocked(handle: string): boolean {
  if (typeof handle !== 'string' || handle.length === 0) return false;
  for (const v of variants(handle)) {
    if (isExact(v) || STRONG.has(v) || containsStrong(v)) return true;
  }
  for (const segment of handle.split('-')) {
    if (!segment) continue;
    for (const v of variants(segment)) if (isExact(v)) return true;
  }
  return false;
}
