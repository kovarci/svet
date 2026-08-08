/**
 * Projection locale plan-tangent : WGS84 <-> mètres.
 *
 * Sur une emprise de la taille de Paris (< 20 km), une projection plane centrée
 * sur la zone reste précise à quelques décimètres près. Inutile de sortir
 * l'artillerie Lambert-93 : on veut juste des mètres pour lancer des rayons.
 */

export function metersPerDegree(lat) {
  const phi = (lat * Math.PI) / 180;
  return {
    lat:
      111132.92 -
      559.82 * Math.cos(2 * phi) +
      1.175 * Math.cos(4 * phi) -
      0.0023 * Math.cos(6 * phi),
    lon: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi),
  };
}

/**
 * Crée un repère métrique local dont l'origine est le coin sud-ouest de la bbox.
 * @param {[number, number, number, number]} bbox [ouest, sud, est, nord]
 */
export function createProjection(bbox) {
  const [west, south, east, north] = bbox;
  const lat0 = (south + north) / 2;
  const mpd = metersPerDegree(lat0);

  const widthM = (east - west) * mpd.lon;
  const heightM = (north - south) * mpd.lat;

  return {
    bbox,
    lat0,
    mpd,
    widthM,
    heightM,
    /** lon/lat -> x/y en mètres, y orienté vers le Nord. */
    forward(lon, lat) {
      return [(lon - west) * mpd.lon, (lat - south) * mpd.lat];
    },
    /** x/y en mètres -> lon/lat. */
    inverse(x, y) {
      return [west + x / mpd.lon, south + y / mpd.lat];
    },
  };
}

/** Étend une bbox d'une marge en mètres (pour capter les ombres venues de l'extérieur). */
export function padBbox(bbox, meters) {
  const [west, south, east, north] = bbox;
  const mpd = metersPerDegree((south + north) / 2);
  const dLon = meters / mpd.lon;
  const dLat = meters / mpd.lat;
  return [west - dLon, south - dLat, east + dLon, north + dLat];
}

/** Longueur en mètres d'une polyligne [lon, lat][]. */
export function lineLengthMeters(coords, projection) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = projection.forward(coords[i - 1][0], coords[i - 1][1]);
    const [x2, y2] = projection.forward(coords[i][0], coords[i][1]);
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}
