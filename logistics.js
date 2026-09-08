/**
 * Логистика доставки — зоны-круги вокруг кухни, тариф без внешних API.
 * Чистая математика: haversine (расстояние по сфере, погрешность <0.3% для коротких дистанций).
 */
const db = require('./db');

const EARTH_R = 6371000; // м

function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Кухня: из env (KITCHEN_LAT/KITCHEN_LON), иначе центр Ташкента. */
function kitchenPoint() {
  return {
    lat: Number(process.env.KITCHEN_LAT || 41.3111),
    lon: Number(process.env.KITCHEN_LON || 69.2797),
  };
}

/**
 * Тариф доставки для точки (lat, lon).
 * Правила:
 *  - активные зоны берём в порядке priority (меньше = важнее);
 *  - точка в круге зоны → тариф зоны (бесплатно при min_order <= totalAmount);
 *  - вне всех зон → надбавка за каждый км сверх границы ближайшей зоны (OVER_ZONE_KM_FEE);
 *  - итог капится MAX_DELIVERY_FEE (по умолчанию 60000).
 */
async function quote(lat, lon, totalAmount = 0) {
  const valid = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!valid(lat) || !valid(lon)) {
    return { ok: false, error: 'Некорректные координаты' };
  }

  const zones = await db.many(
    'SELECT * FROM delivery_zones WHERE active = true ORDER BY priority ASC, id ASC',
  );

  const kitchen = kitchenPoint();
  const distM = haversineM(lat, lon, kitchen.lat, kitchen.lon);

  let matched = null;
  for (const z of zones) {
    const d = haversineM(lat, lon, z.center_lat, z.center_lon);
    if (d <= z.radius_m) { matched = z; break; }
  }

  let fee;
  if (matched) {
    const freeByMin = matched.min_order > 0 && totalAmount >= matched.min_order;
    fee = freeByMin ? 0 : Number(matched.price) || 0;
  } else {
    const overKmFee = Number(process.env.OVER_ZONE_KM_FEE || 5000);
    const nearest = zones.reduce((acc, z) => {
      const d = haversineM(lat, lon, z.center_lat, z.center_lon);
      const beyond = Math.max(0, d - z.radius_m);
      if (!acc || beyond < acc.beyond) acc = { beyond, z };
      return acc;
    }, null);
    const extraKm = Math.max(0, Math.ceil((nearest ? nearest.beyond : distM) / 1000));
    fee = overKmFee * extraKm;
  }

  const cap = Number(process.env.MAX_DELIVERY_FEE || 60000);
  fee = Math.min(Math.round(fee), cap);

  return {
    ok: true,
    fee,
    zone: matched ? matched.name : null,
    inZone: !!matched,
    distanceKm: Math.round(distM / 1000),
    kitchen: { lat: kitchen.lat, lon: kitchen.lon },
    freeDelivery: fee === 0,
    totalWithDelivery: totalAmount > 0 ? Math.round(totalAmount) + fee : null,
  };
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

module.exports = { haversineM, kitchenPoint, quote, isFiniteNum };