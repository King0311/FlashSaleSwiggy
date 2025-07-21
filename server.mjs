import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); // serve HTML

app.post('/upload', upload.single('csvfile'), async (req, res) => {
  try {
    const { restaurantId, lat, lng } = req.body;
    const filePath = req.file.path;
    const csvContent = fs.readFileSync(filePath, 'utf8');
    const records = parse(csvContent, { columns: true });

    const itemKey = Object.keys(records[0]).find(k =>
      k.toLowerCase().includes('item') || k.toLowerCase().includes('name')
    );

    const targetItems = records.map(r => r[itemKey]?.trim()).filter(Boolean);

    const apiUrl = `https://www.swiggy.com/mapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=${lat}&lng=${lng}&restaurantId=${restaurantId}&submitAction=ENTER`;

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(apiUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
      },
    });

    const json = await response.json();
    const cards = json?.data?.cards ?? [];
    const menuItems = [];

    for (const card of cards) {
      const sections = card?.groupedCard?.cardGroupMap?.REGULAR?.cards ?? [];
      for (const section of sections) {
        const c = section?.card?.card;
        const items = [];

        if (c?.itemCards) items.push(...c.itemCards);
        if (c?.categories) {
          for (const cat of c.categories) {
            items.push(...(cat?.itemCards ?? []));
          }
        }

        for (const item of items) {
          const info = item?.card?.info;
          if (!info?.name) continue;
          const name = info.name.trim();
          const basePrice = (info.defaultPrice ?? info.price ?? 0) / 100;
          const finalPrice = info.finalPrice ? info.finalPrice / 100 : basePrice;
          const hasFlashSaleTag = (info.offerTags || []).some(tag =>
            tag?.title?.toLowerCase().includes('flash')
          );
          const isDiscounted = hasFlashSaleTag || finalPrice < basePrice;
          menuItems.push({ name, basePrice, finalPrice, isDiscounted });
        }
      }
    }

    const results = [];
    for (const item of targetItems) {
      const matched = menuItems.find(m => m.name.toLowerCase() === item.toLowerCase());

      if (!matched) {
        results.push({ name: item, basePrice: '-', finalPrice: '-', status: 'not found' });
      } else if (!matched.isDiscounted) {
        results.push({
          name: matched.name,
          basePrice: matched.basePrice,
          finalPrice: matched.finalPrice,
          status: 'not discounted',
        });
      }
    }

    const csvLines = [
      'Item Name,Base Price (₹),Final Price (₹),Status',
      ...results.map(item =>
        `"${item.name}","${item.basePrice}","${item.finalPrice}","${item.status}"`
      ),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=missing_flash_sale.csv');
    res.send(csvLines.join('\n'));
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
