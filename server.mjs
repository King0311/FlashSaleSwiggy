import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: 'uploads/' });
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static HTML

const fetch = (await import('node-fetch')).default;

// Read and parse CSV
const parseCSV = (filePath) => {
  const content = fs.readFileSync(filePath, 'utf8');
  return parse(content, { columns: true, skip_empty_lines: true });
};

// Scrape & compare for one outlet
async function checkOutlet(outlet, itemNames) {
  const restaurantId = outlet.restaurantId;
  const lat = outlet.lat || '19.0176147';
  const lng = outlet.lng || '72.8561644';
  const name = outlet.name || outlet['Restaurant Name'] || `ID_${restaurantId}`;

  const url = `https://www.swiggy.com/mapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=${lat}&lng=${lng}&restaurantId=${restaurantId}&submitAction=ENTER`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const json = await res.json();
    const cards = json?.data?.cards ?? [];
    const menuItems = [];

    for (const card of cards) {
      const sections = card?.groupedCard?.cardGroupMap?.REGULAR?.cards ?? [];
      for (const section of sections) {
        const c = section?.card?.card;
        const items = [];

        if (c?.itemCards) items.push(...c.itemCards);
        if (c?.categories) {
          for (const cat of c.categories) items.push(...(cat?.itemCards ?? []));
        }

        for (const item of items) {
          const info = item?.card?.info;
          if (!info?.name) continue;
          const itemName = info.name.trim();
          const basePrice = (info.defaultPrice ?? info.price ?? 0) / 100;
          const finalPrice = info.finalPrice ? info.finalPrice / 100 : basePrice;
          const hasFlash = (info.offerTags || []).some(tag =>
            tag?.title?.toLowerCase().includes('flash')
          );
          const isDiscounted = hasFlash || finalPrice < basePrice;
          menuItems.push({ name: itemName, basePrice, finalPrice, isDiscounted });
        }
      }
    }

    // Match and return results
    return itemNames.map(item => {
      const match = menuItems.find(m => m.name.toLowerCase() === item.toLowerCase());
      if (!match) {
        return { restaurantId, name, item, basePrice: '-', finalPrice: '-', status: 'Out of Stock' };
      } else if (!match.isDiscounted) {
        return {
          restaurantId,
          name,
          item: match.name,
          basePrice: match.basePrice,
          finalPrice: match.finalPrice,
          status: 'No flash sale active'
        };
      } else {
        return null; // Discounted – skip
      }
    }).filter(Boolean);
  } catch (err) {
    return [{
      restaurantId,
      name,
      item: 'ERROR',
      basePrice: '-',
      finalPrice: '-',
      status: err.message,
    }];
  }
}

// Handle file upload & processing
app.post('/bulk-upload', upload.fields([
  { name: 'itemCsv', maxCount: 1 },
  { name: 'outletCsv', maxCount: 1 }
]), async (req, res) => {
  try {
    const itemRecords = parseCSV(req.files.itemCsv[0].path);
    const outletRecords = parseCSV(req.files.outletCsv[0].path);

    const itemKey = Object.keys(itemRecords[0]).find(k =>
      k.toLowerCase().includes('item') || k.toLowerCase().includes('name')
    );
    const itemNames = [...new Set(itemRecords.map(r => r[itemKey]?.trim()).filter(Boolean))];

    const combinedResults = [];

    for (const outlet of outletRecords) {
      const result = await checkOutlet(outlet, itemNames);
      combinedResults.push(...result);
    }

    const csvOutput = [
      'Restaurant ID,Restaurant Name,Item Name,Base Price (₹),Final Price (₹),Status',
      ...combinedResults.map(r =>
        `"${r.restaurantId}","${r.name}","${r.item}","${r.basePrice}","${r.finalPrice}","${r.status}"`
      )
    ].join('\n');

    // Zip and send the response
    const archive = archiver('zip');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=swiggy_flash_sale_report.zip');
    archive.pipe(res);
    archive.append(csvOutput, { name: 'flash_sale_combined.csv' });
    archive.finalize();
  } catch (err) {
    console.error('❌ Error:', err);
    res.status(500).send('Server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡ Server running at http://localhost:${PORT}`));
