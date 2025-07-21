import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import inquirer from 'inquirer';
import './scrape.mjs';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Step 1: Ask user for CSV file
const csvFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.csv'));
if (csvFiles.length === 0) {
  console.error('❌ No CSV files found in this folder.');
  process.exit(1);
}

const { selectedFile } = await inquirer.prompt([
  {
    type: 'list',
    name: 'selectedFile',
    message: '📂 Choose a CSV file with item names:',
    choices: csvFiles,
  },
]);

// Step 2: Parse CSV
const csvContent = fs.readFileSync(path.join(__dirname, selectedFile), 'utf8');
const records = parse(csvContent, { columns: true, skip_empty_lines: true });
// Detect possible item name column
const sampleRow = records[0];
const possibleKeys = Object.keys(sampleRow);
const itemKey = possibleKeys.find(
  k => k.toLowerCase().includes('name') || k.toLowerCase().includes('item')
);

if (!itemKey) {
  console.log('⚠️ Could not find item name column.');
  process.exit(1);
}

const targetItems = [
  ...new Set(records.map(row => row[itemKey]?.trim()).filter(Boolean))
];


if (targetItems.length === 0) {
  console.log('⚠️ CSV has no valid item names.');
  process.exit(1);
}

// Step 3: Swiggy API details
const restaurantId = '184604'; // Replace with your restaurant ID
const lat = '19.196546';
const lng = '72.824391';

const url = `https://www.swiggy.com/mapi/menu/pl?page-type=REGULAR_MENU&complete-menu=true&lat=19.196546&lng=72.824931&restaurantId=184604&submitAction=ENTER`



// Step 4: Fetch and extract all menu items
async function checkFlashSaleStatus() {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
      },
    });

    const json = await res.json();
    const cards = json?.data?.cards ?? [];
    const menuItems = [];

    for (const card of cards) {
      const sections = card?.groupedCard?.cardGroupMap?.REGULAR?.cards ?? [];

      for (const section of sections) {
        const card = section?.card?.card;

        // Case 1: Direct itemCards
        if (card?.itemCards) {
          for (const item of card.itemCards) {
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

        // Case 2: Nested categories
        if (card?.categories) {
          for (const category of card.categories) {
            for (const item of category.itemCards ?? []) {
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
      }
    }

    console.log(`📦 Total menu items fetched: ${menuItems.length}\n`);

    // Step 5: Compare with CSV items
    const results = [];

    for (const itemName of targetItems) {
      const matched = menuItems.find(
        item => item.name.toLowerCase() === itemName.toLowerCase()
      );

      if (!matched) {
        console.log(`⚠️ Not found: "${itemName}"`);
        results.push({
          name: itemName,
          basePrice: '-',
          finalPrice: '-',
          status: 'not found',
        });
      } else if (!matched.isDiscounted) {
        console.log(
          `❌ "${itemName}" found but no flash sale | ₹${matched.basePrice} → ₹${matched.finalPrice}`
        );
        results.push({
          name: matched.name,
          basePrice: matched.basePrice,
          finalPrice: matched.finalPrice,
          status: 'not discounted',
        });
      } else {
        console.log(`✅ "${itemName}" has flash sale | ₹${matched.basePrice} → ₹${matched.finalPrice}`);
      }
    }

    // Step 6: Output CSV
    if (results.length > 0) {
      const outputPath = path.join(__dirname, 'missing_flash_sale.csv');
      const csvLines = [
        'Item Name,Base Price (₹),Final Price (₹),Status',
        ...results.map(item =>
          `"${item.name}","${item.basePrice}","${item.finalPrice}","${item.status}"`
        ),
      ];
      fs.writeFileSync(outputPath, csvLines.join('\n'), 'utf8');
      console.log(`\n📁 Saved ${results.length} results to: ${outputPath}`);
    } else {
      console.log('\n🎉 All items have flash sale!');
    }
  } catch (error) {
    console.error('🚨 Error:', error.message);
  }
}

checkFlashSaleStatus();
