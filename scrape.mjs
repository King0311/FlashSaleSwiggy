import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import inquirer from 'inquirer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Step 1: Ask for input CSV files
const csvFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.csv'));
if (csvFiles.length < 2) {
  console.error('❌ Need at least 2 CSV files (item list + outlet list)');
  process.exit(1);
}

const { itemFile, outletFile } = await inquirer.prompt([
  {
    type: 'list',
    name: 'itemFile',
    message: '📂 Choose the CSV with item names:',
    choices: csvFiles,
  },
  {
    type: 'list',
    name: 'outletFile',
    message: '🏬 Choose the CSV with outlet info (restaurantId, lat, lng):',
    choices: csvFiles.filter(f => f !== itemFile),
  },
]);

// Step 2: Parse item list
const itemCSV = fs.readFileSync(path.join(__dirname, itemFile), 'utf8');
const itemRecords = parse(itemCSV, { columns: true, skip_empty_lines: true });
const itemKey = Object.keys(itemRecords[0]).find(k =>
  k.toLowerCase().includes('item') || k.toLowerCase().includes('name')
);
const targetItems = [...new Set(itemRecords.map(r => r[itemKey]?.trim()).filter(Boolean))];

// Step 3: Parse outlet list
const outletCSV = fs.readFileSync(path.join(__dirname, outletFile), 'utf8');
const outletRecords = parse(outletCSV, { columns: true, skip_empty_lines: true });

// Step 4: Scrape function per outlet
async function checkOutlet(outlet) {
  const { restaurantId } = outlet;
  const lat = outlet.lat || '19.0176147';
  const lng = outlet.lng || '72.8561644';
  const url = `https://www.swiggy.com/mapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=${lat}&lng=${lng}&restaurantId=${restaurantId}&submitAction=ENTER`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
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
          for (const cat of c.categories) items.push(...(cat.itemCards ?? []));
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

    for (const itemName of targetItems) {
      const matched = menuItems.find(i => i.name.toLowerCase() === itemName.toLowerCase());

      if (!matched) {
        results.push({ restaurantId, name: itemName, basePrice: '-', finalPrice: '-', status: 'not found' });
      } else if (!matched.isDiscounted) {
        results.push({
          restaurantId,
          name: matched.name,
          basePrice: matched.basePrice,
          finalPrice: matched.finalPrice,
          status: 'not discounted',
        });
      }
    }

    console.log(`✅ Processed outlet ${restaurantId}`);
    return results;
  } catch (err) {
    console.error(`❌ Error in outlet ${restaurantId}:`, err.message);
    return [{ restaurantId, name: '-', basePrice: '-', finalPrice: '-', status: `error: ${err.message}` }];
  }
}

// Step 5: Run and aggregate all results
const allResults = [];
for (const outlet of outletRecords) {
  const res = await checkOutlet(outlet);
  allResults.push(...res);
}

// Step 6: Save combined CSV
const csvOutput = [
  'Restaurant ID,Item Name,Base Price (₹),Final Price (₹),Status',
  ...allResults.map(r =>
    `"${r.restaurantId}","${r.name}","${r.basePrice}","${r.finalPrice}","${r.status}"`
  ),
];

fs.writeFileSync(path.join(__dirname, 'flash_sale_combined.csv'), csvOutput.join('\n'), 'utf8');
console.log('\n📁 Results saved to flash_sale_combined.csv');
