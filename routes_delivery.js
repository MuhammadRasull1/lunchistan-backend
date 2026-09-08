/** Доставка: расчёт тарифа + сохранение адреса компании. */
const db = require('./db');
const { auth } = require('./auth');
const { quote, isFiniteNum } = require('./logistics');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function register(app) {
  // Расчёт стоимости доставки по координатам.
  app.post('/api/delivery/quote', async (req, res, next) => {
    try {
      const { lat, lon, totalAmount } = req.body || {};
      const result = await quote(
        typeof lat === 'number' ? lat : Number(lat),
        typeof lon === 'number' ? lon : Number(lon),
        typeof totalAmount === 'number' ? totalAmount : 0,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (err) { next(err); }
  });

  // Адрес компании (доставка по умолчанию на завод/офис).
  app.get('/api/my/address', auth, async (req, res, next) => {
    try {
      if (!req.user.company_id) return res.json({ address: null });
      const c = await db.one('SELECT name, lat, lon, address, size FROM companies WHERE id = $1', [req.user.company_id]);
      res.json({
        address: c && (c.lat != null) ? {
          lat: num(c.lat),
          lon: num(c.lon),
          label: c.address || c.name || '',
        } : null,
      });
    } catch (err) { next(err); }
  });

  // Сохранение адреса компании (координаты + строка адреса).
  app.put('/api/my/address', auth, async (req, res, next) => {
    try {
      if (!req.user.company_id) return res.status(403).json({ error: 'Нет компании' });
      const { lat, lon, label } = req.body || {};
      if (!isFiniteNum(Number(lat)) || !isFiniteNum(Number(lon))) {
        return res.status(400).json({ error: 'Нужны валидные lat/lon' });
      }
      const addressLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 500) : null;
      await db.query(
        'UPDATE companies SET lat = $1, lon = $2, address = $3 WHERE id = $4',
        [num(Number(lat)), num(Number(lon)), addressLabel, req.user.company_id],
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

module.exports = { register };