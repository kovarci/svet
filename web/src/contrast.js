/**
 * Couleurs de l'échelle, rendues lisibles quand elles servent à écrire.
 *
 * L'échelle est faite pour peindre des rues sur un fond sombre : son bas est
 * un bleu nuit, volontairement discret, puisqu'un trottoir abrité ne doit pas
 * attirer l'œil. Mais le même bleu, pris pour écrire l'indice d'un trajet
 * abrité, tombait à 1,25:1 de contraste — invisible, et c'était justement la
 * bonne nouvelle qu'on ne lisait pas.
 *
 * On éclaircit donc la couleur vers le blanc, juste assez pour atteindre le
 * seuil du WCAG, et pas davantage : elle garde sa teinte, donc sa catégorie,
 * et n'éblouit pas plus qu'il ne faut.
 */

/** Rapport de contraste WCAG 2 entre deux couleurs `#rrggbb`. */
export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * La couleur, éclaircie par pas de 5 % vers le blanc jusqu'à se lire sur le
 * fond donné.
 *
 * @param {string} color `#rrggbb`
 * @param {string} background `#rrggbb`
 * @param {number} [minRatio] 4,5:1, seuil du texte courant
 */
export function legibleOn(color, background, minRatio = 4.5) {
  const rgb = channels(color);
  for (let mix = 0; mix <= 1; mix += 0.05) {
    const candidate = hex(rgb.map((c) => c + (255 - c) * mix));
    if (contrastRatio(candidate, background) >= minRatio) return candidate;
  }
  return '#ffffff';
}

function luminance(color) {
  const [r, g, b] = channels(color).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function channels(color) {
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
}

function hex(rgb) {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}
