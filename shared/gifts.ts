/**
 * The gift catalog: 100 gifts in 10 themes. Ids are permanent (they're stored with every
 * gift sent), so never reuse or renumber one; add new gifts at the end.
 */

export interface GiftDef { id: string; name: string; emoji: string; theme: string }
export interface GiftTheme { id: string; name: string; color: string }

export const GIFT_THEMES: GiftTheme[] = [
  { id: 'flowers', name: 'Flowers', color: '#e0567e' },
  { id: 'sweets', name: 'Sweets', color: '#d9823b' },
  { id: 'drinks', name: 'Drinks', color: '#3a9fb8' },
  { id: 'arms', name: 'Arms & Armour', color: '#6b7a90' },
  { id: 'magic', name: 'Magic', color: '#7c55d1' },
  { id: 'treasure', name: 'Treasure', color: '#c99a1e' },
  { id: 'creatures', name: 'Creatures', color: '#3f9a5e' },
  { id: 'cozy', name: 'Cozy', color: '#c46a4a' },
  { id: 'music', name: 'Music & Art', color: '#c2428f' },
  { id: 'sky', name: 'Sky & Sea', color: '#3b6fd4' },
];

const T = (theme: string, list: [string, string, string][]): GiftDef[] => list.map(([id, emoji, name]) => ({ id, emoji, name, theme }));

export const GIFTS: GiftDef[] = [
  ...T('flowers', [
    ['rose', '🌹', 'Red Rose'], ['tulip', '🌷', 'Tulip'], ['sunflower', '🌻', 'Sunflower'], ['blossom', '🌸', 'Cherry Blossom'],
    ['hibiscus', '🌺', 'Hibiscus'], ['bouquet', '💐', 'Bouquet'], ['daisy', '🌼', 'Daisy'], ['lotus', '🪷', 'Lotus'],
    ['clover', '🍀', 'Lucky Clover'], ['maple', '🍁', 'Maple Leaf'],
  ]),
  ...T('sweets', [
    ['cake', '🍰', 'Slice of Cake'], ['cupcake', '🧁', 'Cupcake'], ['cookie', '🍪', 'Cookie'], ['donut', '🍩', 'Doughnut'],
    ['chocolate', '🍫', 'Chocolate Bar'], ['candy', '🍬', 'Sweet'], ['lollipop', '🍭', 'Lollipop'], ['pie', '🥧', 'Warm Pie'],
    ['honey', '🍯', 'Pot of Honey'], ['sundae', '🍨', 'Ice Cream'],
  ]),
  ...T('drinks', [
    ['coffee', '☕️', 'Hot Coffee'], ['green_tea', '🍵', 'Green Tea'], ['bubble_tea', '🧋', 'Bubble Tea'], ['soda', '🥤', 'Soda'],
    ['juice', '🧃', 'Juice Box'], ['milk', '🥛', 'Glass of Milk'], ['punch', '🍹', 'Tropical Punch'], ['mate', '🧉', 'Mate'],
    ['teapot', '🫖', 'Pot of Tea'], ['coconut', '🥥', 'Coconut'],
  ]),
  ...T('arms', [
    ['dagger', '🗡️', 'Dagger'], ['shield', '🛡️', 'Shield'], ['bow', '🏹', 'Bow and Arrow'], ['swords', '⚔️', 'Crossed Swords'],
    ['axe', '🪓', 'Axe'], ['trident', '🔱', 'Trident'], ['boomerang', '🪃', 'Boomerang'], ['war_horn', '📯', 'War Horn'],
    ['helm', '⛑️', 'Helm'], ['boots', '🥾', 'Travel Boots'],
  ]),
  ...T('magic', [
    ['crystal_ball', '🔮', 'Crystal Ball'], ['potion', '🧪', 'Potion'], ['scroll', '📜', 'Scroll'], ['old_key', '🗝️', 'Old Key'],
    ['candle', '🕯️', 'Candle'], ['wand', '🪄', 'Magic Wand'], ['alembic', '⚗️', 'Alembic'], ['spellbook', '📖', 'Spellbook'],
    ['feather', '🪶', 'Feather'], ['stardust', '✨', 'Stardust'],
  ]),
  ...T('treasure', [
    ['gem', '💎', 'Gemstone'], ['crown', '👑', 'Crown'], ['ring', '💍', 'Ring'], ['coin', '🪙', 'Gold Coin'],
    ['treasure_bag', '💰', 'Bag of Gold'], ['compass', '🧭', 'Compass'], ['hourglass', '⌛️', 'Hourglass'], ['map', '🗺️', 'Treasure Map'],
    ['amphora', '🏺', 'Amphora'], ['medal', '🏅', 'Medal'],
  ]),
  ...T('creatures', [
    ['dragon', '🐉', 'Dragon'], ['unicorn', '🦄', 'Unicorn'], ['wolf', '🐺', 'Wolf'], ['owl', '🦉', 'Owl'],
    ['cat', '🐈', 'Cat'], ['fox', '🦊', 'Fox'], ['rabbit', '🐇', 'Rabbit'], ['butterfly', '🦋', 'Butterfly'],
    ['turtle', '🐢', 'Turtle'], ['eagle', '🦅', 'Eagle'],
  ]),
  ...T('cozy', [
    ['teddy', '🧸', 'Teddy Bear'], ['scarf', '🧣', 'Scarf'], ['ribbon', '🎀', 'Ribbon'], ['houseplant', '🪴', 'Houseplant'],
    ['mantel_clock', '🕰️', 'Mantel Clock'], ['wind_chime', '🎐', 'Wind Chime'], ['yarn', '🧶', 'Ball of Yarn'], ['kite', '🪁', 'Kite'],
    ['balloon', '🎈', 'Balloon'], ['campfire', '🔥', 'Campfire'],
  ]),
  ...T('music', [
    ['guitar', '🎸', 'Guitar'], ['violin', '🎻', 'Violin'], ['keyboard', '🎹', 'Keyboard'], ['drum', '🥁', 'Drum'],
    ['trumpet', '🎺', 'Trumpet'], ['palette', '🎨', 'Paint Palette'], ['masks', '🎭', 'Theatre Masks'], ['fountain_pen', '🖋️', 'Fountain Pen'],
    ['camera', '📷', 'Camera'], ['song', '🎵', 'A Song'],
  ]),
  ...T('sky', [
    ['star', '🌟', 'Shining Star'], ['rainbow', '🌈', 'Rainbow'], ['sun', '☀️', 'Sunshine'], ['moon', '🌙', 'Crescent Moon'],
    ['snowflake', '❄️', 'Snowflake'], ['wave', '🌊', 'Ocean Wave'], ['seashell', '🐚', 'Seashell'], ['planet', '🪐', 'Ringed Planet'],
    ['comet', '☄️', 'Comet'], ['snowman', '⛄️', 'Snowman'],
  ]),
];

export const GIFT_BY_ID = new Map(GIFTS.map((g) => [g.id, g]));
export const GIFT_THEME_BY_ID = new Map(GIFT_THEMES.map((t) => [t.id, t]));

export const GIFT_RULES = {
  /** Gifts each member can send in any 24 hours. */
  perDay: 5,
  /** Characters in the optional message. */
  messageMax: 200,
  /** Your received gifts per page. */
  perPage: 20,
} as const;
