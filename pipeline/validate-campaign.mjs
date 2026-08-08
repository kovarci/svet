/**
 * Campagne de validation : le modèle d'ombres sur plusieurs sites, pas un seul.
 *
 * La validation ne tenait que sur les cours du Louvre — un point, pas une
 * courbe. Une corrélation de 0,757 sur un site peut être une coïncidence
 * heureuse : la cour Carrée est un cas facile, vaste, minérale, bordée de
 * bâtiments hauts et réguliers.
 *
 * On la rejoue donc sur des sites choisis pour **varier ce qui pourrait faire
 * échouer le modèle** : hauteur des bâtiments, régularité du bâti, présence
 * d'arbres, orientation. Le résultat n'est plus un chiffre mais une
 * distribution — et surtout, un site qui décroche devient repérable.
 *
 * Chaque site tourne dans son propre processus : un site sans date de vol ou
 * sans sol dégagé n'emporte pas la campagne.
 *
 *   node pipeline/validate-campaign.mjs
 *   node pipeline/validate-campaign.mjs --model=vector   (point de comparaison)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Sites de validation.
 *
 * Le critère n'est pas la beauté mais la **sensibilité** : il faut de vastes
 * surfaces minérales dégagées, bordées de bâtiments dont l'ombre a un bord
 * franc. Un site trop boisé ou trop dense ne discrimine rien.
 */
const SITES = [
  {
    name: 'Cour Carrée du Louvre',
    bbox: [2.333, 48.86, 2.34, 48.8635],
    why: 'référence historique — vaste, minérale, bâti haut et régulier',
  },
  {
    name: 'Esplanade des Invalides',
    bbox: [2.3115, 48.8585, 2.3185, 48.8635],
    why: 'grande esplanade dégagée, bâti bas d’un côté seulement',
  },
  {
    name: 'Place de la Concorde',
    bbox: [2.318, 48.8635, 2.325, 48.868],
    why: 'très ouverte : les ombres y sont rares et longues',
  },
  {
    name: 'Champ-de-Mars',
    bbox: [2.294, 48.854, 2.301, 48.858],
    why: 'ombre d’une structure très haute et ajourée — cas difficile',
  },
  {
    name: 'Place des Vosges',
    bbox: [2.3635, 48.8545, 2.367, 48.857],
    why: 'petite place fermée, bâti homogène, arbres au centre',
  },
  {
    name: 'Parvis de la Défense (Puteaux)',
    bbox: [2.236, 48.8895, 2.243, 48.8935],
    why: 'tours de grande hauteur — teste les hauteurs extrêmes',
  },
  {
    name: 'Place de la Bastille',
    bbox: [2.366, 48.8515, 2.373, 48.856],
    why: 'carrefour ouvert, bâti hétérogène',
  },
  {
    name: 'Esplanade de la Bibliothèque nationale',
    bbox: [2.374, 48.8295, 2.381, 48.834],
    why: 'bâti récent, quatre tours identiques — géométrie connue',
  },
];

const extra = process.argv.slice(2).filter((a) => a.startsWith('--'));

console.log(`\n▌ Campagne de validation — ${SITES.length} sites`);
if (extra.length) console.log(`  options : ${extra.join(' ')}`);
console.log();

const results = [];
for (const site of SITES) {
  process.stdout.write(`  ${site.name.padEnd(38)} …`);
  const started = Date.now();
  const outcome = await run(site);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  if (!outcome) {
    process.stdout.write(`\r  ${site.name.padEnd(38)} ✗ écarté          ${seconds} s\n`);
    results.push({ site, failed: true });
    continue;
  }
  process.stdout.write(
    `\r  ${site.name.padEnd(34)} r ${outcome.r.toFixed(3)}` +
      `  accord ${String((outcome.agreement * 100).toFixed(0)).padStart(2)} %` +
      `  bord ${String(outcome.edgeMedian ?? '—').padStart(4)} m` +
      `  témoin ${String(outcome.decoyMedian ?? '—').padStart(4)} m` +
      `  gain ×${outcome.edgeMedian && outcome.decoyMedian ? (outcome.decoyMedian / outcome.edgeMedian).toFixed(2) : '—'}` +
      `  à 2 m ${String(Math.round((outcome.within2m ?? 0) * 100)).padStart(3)} %\n`,
  );
  void seconds;
  results.push({ site, ...outcome });
}

const ok = results.filter((r) => !r.failed);
if (ok.length === 0) {
  console.error('\n  Aucun site n’a abouti.\n');
  process.exit(1);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

console.log('\n  ─────────────────────────────────────────────────────────');
console.log(`  ${ok.length}/${SITES.length} sites exploitables`);
console.log(
  `  corrélation : médiane ${median(ok.map((r) => r.r)).toFixed(3)}` +
    `  · min ${Math.min(...ok.map((r) => r.r)).toFixed(3)}` +
    `  · max ${Math.max(...ok.map((r) => r.r)).toFixed(3)}`,
);
console.log(
  `  accord pixel : médiane ${(100 * median(ok.map((r) => r.agreement))).toFixed(1)} %` +
    `  · IoU médiane ${(100 * median(ok.map((r) => r.iou))).toFixed(1)} %`,
);

// Un site nettement en dessous des autres est plus instructif que la moyenne :
// c'est là que le modèle a quelque chose à apprendre — ou bien c'est le site
// qui n'est pas jugeable, et c'est la séparabilité qui tranche.
const worst = ok.reduce((a, b) => (b.r < a.r ? b : a));
console.log(`\n  Le plus faible : ${worst.site.name} (r ${worst.r.toFixed(3)})`);
console.log(`    ${worst.site.why}`);

// Corrélation de rangs entre séparabilité et corrélation obtenue. Si les deux
// vont ensemble, les sites faibles le sont parce qu'ils sont **illisibles**, et
// non parce que le modèle s'y trompe. C'est une distinction qui change tout :
// l'une demande un meilleur modèle, l'autre de meilleurs sites.
const rank = (values) => {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  order.forEach(([, i], r) => (out[i] = r + 1));
  return out;
};
const rs = rank(ok.map((r) => r.r));
const ss = rank(ok.map((r) => r.ceiling));
const n = ok.length;
const d2 = rs.reduce((sum, r, i) => sum + (r - ss[i]) ** 2, 0);
const rho = 1 - (6 * d2) / (n * (n * n - 1));

const meanReach = ok.reduce((sum, r) => sum + r.reach, 0) / ok.length;
console.log(
  `\n  Plafond du site (séparation optimale de l’image, méthode d’Otsu) contre` +
    ` corrélation obtenue : ρ = ${rho.toFixed(2)}`,
);
console.log(
  `  Part du plafond atteinte par le modèle : ${(100 * meanReach).toFixed(0)} % en moyenne`,
);
// Le verdict : l'accord tient-il à l'heure, ou à la surface ?
const collapses = ok.map((r) => r.collapse);
const worstCollapse = ok.reduce((a, b) => (b.collapse < a.collapse ? b : a));
console.log(
  `\n  Effondrement en décalant l’heure de deux heures :` +
    ` médiane ${(100 * median(collapses)).toFixed(0)} %` +
    ` · minimum ${(100 * worstCollapse.collapse).toFixed(0)} % (${worstCollapse.site.name})`,
);
// Exactitude géométrique : une distance en mètres, pas un coefficient. Le
// témoin est la même mesure avec un soleil délibérément faux — dans une image
// pleine de bords, un bord calculé tombe près d'un bord observé par hasard.
const withEdges = ok.filter((r) => r.edgeMedian !== null && r.decoyMedian !== null);
if (withEdges.length > 0) {
  const gains = withEdges.map((r) => r.decoyMedian / r.edgeMedian);
  console.log(
    `\n  Écart des bords d’ombre : médiane ${median(withEdges.map((r) => r.edgeMedian)).toFixed(1)} m` +
      ` · témoin (soleil faux) ${median(withEdges.map((r) => r.decoyMedian)).toFixed(1)} m` +
      ` · gain ×${median(gains).toFixed(2)}`,
  );
  console.log(
    `  Bords calculés à moins de 2 m d’un bord observé : ` +
      `${(100 * median(withEdges.map((r) => r.within2m))).toFixed(0)} %`,
  );
  console.log(
    median(gains) > 1.5
      ? '    Le vrai soleil place les bords nettement mieux qu’un soleil faux :\n' +
          '    la mesure discrimine, et le chiffre en mètres veut dire quelque chose.'
      : '    Le témoin fait presque aussi bien : dans ces images, un bord calculé\n' +
          '    tombe près d’un bord observé quel que soit le soleil. La mesure ne\n' +
          '    sépare pas assez pour qu’on lise le chiffre en mètres comme une justesse.',
  );
}

const overlaps = ok.map((r) => r.overlap);
const ratios = ok.map((r) => r.normalised);
console.log(
  `  Champ du modèle inchangé par ce décalage : ${(100 * median(overlaps)).toFixed(0)} % des pixels` +
    ` — seuls ${(100 * (1 - median(overlaps))).toFixed(0)} % pouvaient donc changer d’avis.`,
);
console.log(`  Effondrement rapporté à ce qui était possible : ${median(ratios).toFixed(2)}`);
console.log(
  median(ratios) > 0.8
    ? '\n    L’albédo d’une surface ne bouge pas quand le soleil bouge. Que la\n' +
        '    corrélation chute d’autant que le champ d’ombres a réellement changé\n' +
        '    établit que le modèle décrit bien des **ombres** — y compris là où son\n' +
        '    accord absolu est faible. Les sites ouverts sont bruités, pas mal modélisés.'
    : '\n    La corrélation résiste plus que le champ d’ombres n’a bougé : une part\n' +
        '    de l’accord ne dépend pas du soleil, donc tient aux surfaces. Reste à\n' +
        '    savoir laquelle — ce test la mesure, il ne l’explique pas.',
);
console.log('  ─────────────────────────────────────────────────────────\n');

function run(site) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=4096',
        path.join(HERE, 'src/validate-shadows.js'),
        `--bbox=${site.bbox.join(',')}`,
        '--brief',
        ...extra,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith('RESULTAT '));
      if (!line) return resolve(null);
      try {
        resolve(JSON.parse(line.slice('RESULTAT '.length)));
      } catch {
        resolve(null);
      }
    });
    child.on('error', () => resolve(null));
  });
}
