import { existsSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vite';

/**
 * Répond 404 pour un fichier de données absent, au lieu de la page d'accueil.
 *
 * Un serveur d'application à page unique renvoie `index.html` avec un code 200
 * pour tout chemin inconnu. MapLibre reçoit alors du HTML là où il attend un
 * protobuf, et le journal se remplit de « Unimplemented type: 4 ».
 *
 * Le pipeline contournait ça en écrivant une tuile vide pour chaque case de
 * l'emprise — tenable sur une zone, qui en compte quinze cents. Une région en
 * demanderait des centaines de milliers, et surtout **elle a de vrais trous** :
 * les coins de l'emprise englobante tombent hors du territoire, et une
 * construction s'étale sur des heures pendant lesquelles la moitié des cellules
 * n'existe pas encore. Le trou est ici l'état normal, pas l'exception.
 *
 * Un 404 est la réponse juste, et MapLibre sait la lire : il tient la tuile pour
 * vide et n'en parle plus. À déployer aussi en production — c'est une règle de
 * réécriture à exclure, pas du code.
 */
function dataNotFound() {
  return {
    name: 'svet-data-404',
    configureServer(server) {
      // Ni avant ni après la pile interne de Vite : les deux positions ratent.
      // Placé avant, on court-circuite le middleware qui sert `public/` et on
      // répond 404 à des fichiers bien présents. Placé après (hook rendu), on
      // arrive derrière le repli HTML, qui a déjà répondu `index.html`.
      //
      // On se place donc avant, et on regarde le disque nous-mêmes : la
      // question « ce fichier existe-t-il ? » a une réponse simple, et c'est
      // exactement celle que le repli HTML se garde de poser.
      const root = path.resolve(server.config.root, server.config.publicDir);
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/data/')) return next();
        const requested = new URL(req.url, 'http://localhost').pathname;
        const file = path.join(root, decodeURIComponent(requested));
        // Sortie de l'arborescence servie : refusée comme une absence.
        if (file.startsWith(root) && existsSync(file)) return next();
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end(`Pas de données à ${requested}`);
      });
    },
  };
}

export default defineConfig({
  plugins: [dataNotFound()],
  // Les données calculées ne sont pas des sources : rien ne doit les surveiller.
  //
  // La pyramide régionale compte 118 643 tuiles. Confié au guetteur de Vite,
  // cet arbre lui coûte assez d'entrées-sorties pour que **servir 1,4 Ko de
  // `zones.json` prenne treize secondes** — l'application restait bloquée sur
  // « Chargement des données… » et rien dans la console ne l'expliquait.
  //
  // Aucune de ces tuiles ne change en cours de session ; quand elles changent,
  // c'est que le pipeline a tourné, et on recharge la page. Il n'y a donc rien
  // à perdre à les ignorer.
  server: {
    // 5178 reste le port par défaut — c'est celui qu'annonce le README — mais
    // `PORT` l'emporte. Un outillage qui lance le serveur à notre place choisit
    // un port libre et surveille celui-là ; le figer ici le ferait attendre une
    // adresse où personne ne répond, ou échouer si 5178 est déjà pris.
    port: Number(process.env.PORT) || 5178,
    open: false,
    watch: { ignored: ['**/public/data/**'] },
  },
  build: { outDir: 'dist' },
});
