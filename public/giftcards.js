// Gift card brands people can add to their list. The one list for both sides: the app loads it with a
// <script> tag, and src/wishlist.js imports it (the Worker bundle runs it once and reads the same global).
// Adding a brand: append a row. Never change or reuse a key, it's what's saved in the database.
// [key, name, card color, emoji, group]. Colors are darkened where needed so white text stays readable.
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

    ["homedepot", "The Home Depot", "#D45200", "🛠️", "Home"],
    ["lowes", "Lowe's", "#004990", "🔨", "Home"],
    ["wayfair", "Wayfair", "#7B189F", "🛋️", "Home"],
    ["ikea", "IKEA", "#0058A3", "🪑", "Home"],
    ["bathbody", "Bath & Body Works", "#0C2340", "🫧", "Home"],

    ["sephora", "Sephora", "#1A1A1A", "💄", "Beauty"],
    ["ulta", "Ulta Beauty", "#C4511A", "💅", "Beauty"],

    ["nordstrom", "Nordstrom", "#2B2B2B", "👗", "Clothing & shoes"],
    ["macys", "Macy's", "#C8102E", "⭐", "Clothing & shoes"],
    ["oldnavy", "Old Navy", "#00335B", "👕", "Clothing & shoes"],
    ["nike", "Nike", "#111111", "👟", "Clothing & shoes"],
    ["lululemon", "lululemon", "#A3192B", "🧘", "Clothing & shoes"],
    ["dicks", "Dick's Sporting Goods", "#006A4E", "⚾", "Clothing & shoes"],

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
  globalThis.GIFT_CARDS = rows.map(([key, name, color, emoji, group]) => ({ key, name, color, emoji, group }));
})();
