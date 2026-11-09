// Gift card brands people can add to their list. The one list for both sides: the app loads it with a
// <script> tag, and src/wishlist.js imports it (the Worker bundle runs it once and reads the same global).
// Adding a brand: append a row. Never change or reuse a key, it's what's saved in the database.
// [key, name, card color, emoji, group]. Colors are darkened where needed so white text stays readable.
// Logos live in public/brands/<key>.svg or .png (listed below); brands without one show their emoji.
(function () {
  const rows = [
    ["starbucks", "Starbucks", "#00704A", "☕", "Coffee & food"],
    ["dunkin", "Dunkin'", "#D4561A", "🍩", "Coffee & food"],
    ["panera", "Panera Bread", "#4F6A2B", "🥖", "Coffee & food"],
    ["chipotle", "Chipotle", "#6B2410", "🌯", "Coffee & food"],
    ["chickfila", "Chick-fil-A", "#C8102E", "🍗", "Coffee & food"],
    ["olivegarden", "Olive Garden", "#5C6F2B", "🍝", "Coffee & food"],
    ["doordash", "DoorDash", "#D91400", "🛵", "Coffee & food"],
    ["ubereats", "Uber Eats", "#0E7A45", "🥡", "Coffee & food"],

    ["amazon", "Amazon", "#232F3E", "📦", "Shopping"],
    ["target", "Target", "#CC0000", "🎯", "Shopping"],
    ["walmart", "Walmart", "#0062B8", "🛒", "Shopping"],
    ["costco", "Costco", "#005DAA", "🛍️", "Shopping"],
    ["tjmaxx", "TJ Maxx", "#A6192E", "🏷️", "Shopping"],
    ["kohls", "Kohl's", "#3A2A2E", "🧺", "Shopping"],
    ["visa", "Visa prepaid", "#1A1F71", "💳", "Shopping"],
    ["ross", "Ross", "#0055A5", "🏷️", "Shopping"],
    ["marshalls", "Marshalls", "#1F3F7A", "🛍️", "Shopping"],

    ["homedepot", "The Home Depot", "#D45200", "🛠️", "Home"],
    ["lowes", "Lowe's", "#004990", "🔨", "Home"],
    ["wayfair", "Wayfair", "#7B189F", "🛋️", "Home"],
    ["ikea", "IKEA", "#0058A3", "🪑", "Home"],
    ["bathbody", "Bath & Body Works", "#0C2340", "🫧", "Home"],

    ["sephora", "Sephora", "#1A1A1A", "💄", "Beauty"],
    ["ulta", "Ulta Beauty", "#C4511A", "💅", "Beauty"],

    ["nordstrom", "Nordstrom", "#2B2B2B", "👗", "Clothing"],
    ["macys", "Macy's", "#C8102E", "⭐", "Clothing"],
    ["oldnavy", "Old Navy", "#00335B", "👕", "Clothing"],
    ["zara", "Zara", "#1A1A1A", "🧥", "Clothing"],
    ["hm", "H&M", "#C8001A", "👚", "Clothing"],
    ["americaneagle", "American Eagle", "#1B2A4A", "🦅", "Clothing"],
    ["aerie", "Aerie", "#A8325E", "🩱", "Clothing"],
    ["gap", "Gap", "#002F6C", "🧢", "Clothing"],
    ["bananarepublic", "Banana Republic", "#2B2B2B", "🧥", "Clothing"],
    ["uniqlo", "Uniqlo", "#C60000", "🧣", "Clothing"],
    ["abercrombie", "Abercrombie & Fitch", "#1C2A39", "🌲", "Clothing"],
    ["hollister", "Hollister", "#7A1F35", "🏄", "Clothing"],
    ["urbanoutfitters", "Urban Outfitters", "#333333", "🪩", "Clothing"],
    ["anthropologie", "Anthropologie", "#6B4E3D", "🌿", "Clothing"],
    ["freepeople", "Free People", "#4A3B5C", "🌼", "Clothing"],
    ["jcrew", "J.Crew", "#2C3E50", "👔", "Clothing"],
    ["madewell", "Madewell", "#3B3B6D", "👖", "Clothing"],
    ["levis", "Levi's", "#B5112C", "👖", "Clothing"],
    ["victoriassecret", "Victoria's Secret", "#B0174F", "🎀", "Clothing"],
    ["express", "Express", "#1A1A1A", "✨", "Clothing"],
    ["carters", "Carter's", "#0072A3", "🧸", "Clothing"],

    ["nike", "Nike", "#111111", "👟", "Shoes & active"],
    ["adidas", "adidas", "#1A1A1A", "👟", "Shoes & active"],
    ["lululemon", "lululemon", "#A3192B", "🧘", "Shoes & active"],
    ["athleta", "Athleta", "#2E4A62", "🧘", "Shoes & active"],
    ["underarmour", "Under Armour", "#1D1D1D", "🏋️", "Shoes & active"],
    ["northface", "The North Face", "#B5121B", "🏔️", "Shoes & active"],
    ["patagonia", "Patagonia", "#1F3A5F", "🏕️", "Shoes & active"],
    ["columbia", "Columbia", "#1D428A", "❄️", "Shoes & active"],
    ["dicks", "Dick's Sporting Goods", "#006A4E", "⚾", "Shoes & active"],
    ["footlocker", "Foot Locker", "#222222", "🏀", "Shoes & active"],
    ["converse", "Converse", "#1A1A1A", "⭐", "Shoes & active"],
    ["vans", "Vans", "#C8102E", "🛹", "Shoes & active"],
    ["newbalance", "New Balance", "#C00A28", "🏃", "Shoes & active"],
    ["dsw", "DSW", "#1A1A1A", "👠", "Shoes & active"],

    ["barnesnoble", "Barnes & Noble", "#2A5934", "📚", "Books, music & movies"],
    ["audible", "Audible", "#B85F00", "🎧", "Books, music & movies"],
    ["netflix", "Netflix", "#B20710", "🍿", "Books, music & movies"],
    ["spotify", "Spotify", "#137A37", "🎵", "Books, music & movies"],
    ["amc", "AMC Theatres", "#A8001A", "🎬", "Books, music & movies"],
    ["apple", "Apple", "#1D1D1F", "🍎", "Books, music & movies"],

    ["googleplay", "Google Play", "#01875F", "📱", "Games & apps"],
    ["steam", "Steam", "#1B2838", "🎮", "Games & apps"],
    ["playstation", "PlayStation", "#003791", "🕹️", "Games & apps"],
    ["xbox", "Xbox", "#107C10", "👾", "Games & apps"],
    ["nintendo", "Nintendo eShop", "#C4000F", "🎲", "Games & apps"],
    ["roblox", "Roblox", "#2B2D31", "🧱", "Games & apps"],

    ["airbnb", "Airbnb", "#D9324F", "🏡", "Trips & outings"],
    ["uber", "Uber", "#111111", "🚗", "Trips & outings"],
    ["southwest", "Southwest Airlines", "#304CB2", "✈️", "Trips & outings"],
    ["topgolf", "Topgolf", "#00468B", "⛳", "Trips & outings"],
  ];
  // Logo files in public/brands. Monochrome marks (svg) are from Simple Icons (CC0); the rest are each store's own icon.
  const svg = new Set("adidas airbnb apple audible doordash express googleplay hm ikea macys netflix newbalance nike northface playstation roblox southwest spotify starbucks steam target uber ubereats underarmour uniqlo visa zara".split(" "));
  const png = new Set("abercrombie amazon amc americaneagle anthropologie athleta bananarepublic barnesnoble carters chickfila chipotle costco dsw dunkin freepeople hollister jcrew kohls levis lowes lululemon madewell marshalls nintendo nordstrom oldnavy panera patagonia ross sephora tjmaxx topgolf ulta urbanoutfitters vans victoriassecret walmart wayfair xbox".split(" "));
  const logo = (key) => (svg.has(key) ? `/brands/${key}.svg` : png.has(key) ? `/brands/${key}.png` : null);
  globalThis.GIFT_CARDS = rows.map(([key, name, color, emoji, group]) => ({ key, name, color, emoji, group, logo: logo(key) }));
})();
