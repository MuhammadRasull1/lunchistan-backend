const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// MVP данные для Ланчистана
const menu = [
  {
    id: 1,
    name: "Фирменный Плов Lunchistan",
    description: "Настоящий праздничный плов с нежным мясом и ароматными специями для сытного обеда всей команды.",
    price: 45000,
    imageUrl: "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=1000"
  }
];

app.get('/api/menu', (req, res) => {
  res.json(menu);
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер Lunchistan успешно запущен на http://localhost:${PORT}`);
});