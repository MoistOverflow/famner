// Grocery helpers: reading a quantity out of what was typed, and guessing the store aisle.

/** Aisles in the order most stores are walked. */
export const AISLES = [
  ['produce', 'Fruit & veg'],
  ['bakery', 'Bakery'],
  ['meat', 'Meat & fish'],
  ['dairy', 'Dairy & eggs'],
  ['pantry', 'Pantry'],
  ['frozen', 'Frozen'],
  ['drinks', 'Drinks'],
  ['household', 'Household'],
  ['personal', 'Personal care'],
  ['other', 'Other']
];
export const AISLE_IDS = AISLES.map(([id]) => id);
export const aisleLabel = (id) => AISLES.find(([a]) => a === id)?.[1] ?? 'Other';

const MAX_QTY = 99;

/**
 * "2 milk", "milk x2", "2x milk", "milk ×3", "3 × eggs" → { name, qty }.
 * Only a plain count is taken out; "2 lb beef" or "1.5 l water" are left as they are.
 */
export function parseItem(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  const clamp = (n) => Math.min(MAX_QTY, Math.max(1, n));
  let m = s.match(/^(\d{1,2})\s*[x×]?\s+(.+)$/i) ?? s.match(/^(\d{1,2})[x×](\S.*)$/i);
  if (m && !/^(?:lbs?|kg|g|oz|l|ml|pack|cans?|bottles?|dozen)\b/i.test(m[2])) return { name: m[2].trim(), qty: clamp(Number(m[1])) };
  m = s.match(/^(.+?)\s*[x×]\s*(\d{1,2})$/i);
  if (m) return { name: m[1].trim(), qty: clamp(Number(m[2])) };
  return { name: s, qty: 1 };
}

const WORDS = {
  produce: 'apple banana orange lemon lime grape berries berry strawberr blueberr raspberr melon watermelon peach pear plum cherr mango pineapple kiwi avocado tomato potato onion garlic carrot celery lettuce salad spinach kale cabbage broccoli cauliflower cucumber pepper zucchini squash pumpkin mushroom corn beans herbs cilantro parsley basil ginger fruit veg vegetable scallion leek asparagus beet radish',
  bakery: 'bread bagel bun buns roll rolls croissant muffin baguette tortilla pita cake donut doughnut pastry loaf',
  meat: 'chicken beef pork steak mince ground turkey ham bacon sausage salmon tuna fish shrimp prawn lamb meat deli salami',
  dairy: 'milk cheese yogurt yoghurt butter cream egg eggs cottage cheddar mozzarella parmesan margarine',
  frozen: 'frozen ice pizza fries popsicle',
  drinks: 'water juice soda coke pop beer wine coffee tea sparkling lemonade kombucha',
  household: 'towel tissue detergent soap dish sponge trash foil wrap cleaner bleach batteries bulb laundry napkins',
  personal: 'shampoo conditioner toothpaste toothbrush deodorant razor lotion sunscreen floss diapers wipes tampons pads vitamins medicine',
  pantry: 'rice pasta noodles flour sugar salt oil vinegar sauce ketchup mustard mayo cereal oats oatmeal peanut jam honey syrup spice beans soup can canned stock broth chips crackers cookies snacks nuts baking chocolate'
};
const ORDER = ['frozen', 'personal', 'household', 'drinks', 'dairy', 'meat', 'bakery', 'produce', 'pantry'];

const PHRASES = [
  ['peanut butter', 'pantry'], ['coconut milk', 'pantry'], ['ice cream', 'frozen'], ['sour cream', 'dairy'],
  ['cream cheese', 'dairy'], ['hot dog', 'meat'], ['paper towel', 'household'], ['toilet paper', 'household'],
  ['dish soap', 'household'], ['hand soap', 'personal'], ['coffee beans', 'drinks'], ['green beans', 'produce']
];

/** A best guess at the aisle from the item's name ('other' when nothing matches). */
export function guessAisle(name) {
  const n = ` ${String(name ?? '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ')} `;
  for (const [p, aisle] of PHRASES) if (n.includes(` ${p}`)) return aisle;
  // a word matches when it starts with a listed word and adds at most a plural-like ending
  // ("bananas", "strawberries"), so "sourdough" isn't "sour" and "popcorn" isn't "pop"
  const tokens = n.trim().split(' ');
  for (const aisle of ORDER) {
    for (const w of WORDS[aisle].split(' ')) {
      if (tokens.some((t) => t.startsWith(w) && t.length - w.length <= 3)) return aisle;
    }
  }
  return 'other';
}

/** "milk" or "3 × milk" */
export const itemText = (i) => (i.qty > 1 ? `${i.qty} × ${i.name}` : i.name);
