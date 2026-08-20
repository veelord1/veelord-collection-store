
require("dotenv").config({ path: ".env.local" });const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY,
    {
        realtime: {
            transport: ws
        }
    }
);const app = express();
const PORT = process.env.PORT || 3000;
const STORE_NAME = process.env.STORE_NAME || "Veelord Collection & Gift Store";
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || "2349130051086").replace(/\D/g, "");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const uploadDir = path.join(__dirname, "public", "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(path.join(dataDir, "store.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  image TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
`);db.prepare(`
  UPDATE products
  SET category = CASE LOWER(TRIM(category))
    WHEN 'watches' THEN 'Watches'
    WHEN 'flowers' THEN 'Flowers'
    WHEN 'handbags' THEN 'Handbags'
    WHEN 'shoes' THEN 'Shoes'
    WHEN 'clothes' THEN 'Clothes'
    WHEN 'jewellery' THEN 'Jewellery'
    WHEN 'jewelry' THEN 'Jewellery'
    WHEN 'gifts' THEN 'Gifts'
    ELSE TRIM(category)
  END
`).run();


const adminUser = process.env.ADMIN_USERNAME || "admin";
const adminPass = process.env.ADMIN_PASSWORD || "ChangeMe123!";
const existingAdmin = db.prepare("SELECT id FROM admins WHERE username=?").get(adminUser);
if (!existingAdmin) {
  db.prepare("INSERT INTO admins (username,password_hash) VALUES (?,?)")
    .run(adminUser, bcrypt.hashSync(adminPass, 10));
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 1000 * 60 * 60 * 8 }
}));

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.toLowerCase().replace(/[^a-z0-9.]+/g, "-");
    cb(null, Date.now() + "-" + safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPG, PNG, WEBP or GIF images are allowed."));
  }
});

function auth(req, res, next) {
  if (!req.session.adminId) return res.redirect("/admin/login");
  next();
}

function waLink(product) {
  const text = `Hello Veelord Collection & Gift Store, I want to order:\n\nProduct: ${product.name}\nPrice: ₦${Number(product.price).toLocaleString()}\n\nPlease confirm availability.`;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

app.get("/", async (req, res, next) => {
  try {
    const category = req.query.category || "";
    const q = (req.query.q || "").trim();

    let productQuery = supabase
      .from("products")
      .select("*")
      .order("id", { ascending: false });

    if (category) {
      productQuery = productQuery.eq("category", category);
    }

    if (q) {
      productQuery = productQuery.or(
        `name.ilike.%${q}%,description.ilike.%${q}%`
      );
    }

    const { data: products, error: productsError } = await productQuery;

    if (productsError) throw productsError;

    const { data: categoryRows, error: categoriesError } = await supabase
      .from("products")
      .select("category")
      .order("category");

    if (categoriesError) throw categoriesError;

    const categories = [
      ...new Set((categoryRows || []).map(row => row.category))
    ];

    res.render("index", {
      storeName: STORE_NAME,
      products: (products || []).map(p => ({
        ...p,
        wa: waLink(p)
      })),
      categories,
      activeCategory: category,
    q: q
    });

  } catch (err) {
    next(err);
  }
});
app.get("/admin/login", (req, res) => {
  if (req.session.adminId) return res.redirect("/admin");
  res.render("login", { error: null, storeName: STORE_NAME });
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare("SELECT * FROM admins WHERE username=?").get(username);
  if (!admin || !bcrypt.compareSync(password || "", admin.password_hash)) {
    return res.status(401).render("login", { error: "Invalid username or password.", storeName: STORE_NAME });
  }
  req.session.adminId = admin.id;
  res.redirect("/admin");
});

app.post("/admin/logout", auth, (req, res) => req.session.destroy(() => res.redirect("/")));

app.get("/admin", auth, (req, res) => {
  const products = db.prepare("SELECT * FROM products ORDER BY id DESC").all();
  const categories = db.prepare("SELECT DISTINCT category FROM products ORDER BY category").all().map(x => x.category);
  res.render("admin", { storeName: STORE_NAME, products, categories });
});

app.post("/admin/products", auth, upload.single("image"), async (req, res, next) => {
  try {
    const { name, category, price, description } = req.body;

    if (!name || !category || !req.file) {
      return res.status(400).send("Name, category and image are required.");
    }

    const fileBuffer = fs.readFileSync(req.file.path);

    const fileName = `${Date.now()}-${req.file.filename}`;

    const { error: uploadError } = await supabase.storage
      .from("product-images")
      .upload(fileName, fileBuffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      throw uploadError;
    }

    const { data: publicUrlData } = supabase.storage
      .from("product-images")
      .getPublicUrl(fileName);

    const imageUrl = publicUrlData.publicUrl;

    db.prepare(`
      INSERT INTO products(name, category, price, description, image)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      name,
      category,
      Number(price || 0),
      description || "",
      imageUrl
    );

    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});
app.post("/admin/products/:id/edit", auth, upload.single("image"), async (req, res, next) => {
  try {
    const old = db
      .prepare("SELECT * FROM products WHERE id=?")
      .get(req.params.id);

    if (!old) {
      return res.status(404).send("Product not found.");
    }

    let imageUrl = old.image;

    if (req.file) {
      const fileBuffer = fs.readFileSync(req.file.path);
      const fileName = `${Date.now()}-${req.file.filename}`;

      const { error: uploadError } = await supabase.storage
        .from("product-images")
        .upload(fileName, fileBuffer, {
          contentType: req.file.mimetype,
          upsert: false
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage
        .from("product-images")
        .getPublicUrl(fileName);

      imageUrl = publicUrlData.publicUrl;

      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    }

    db.prepare(
      "UPDATE products SET name=?, category=?, price=?, description=?, image=? WHERE id=?"
    ).run(
      req.body.name,
      req.body.category,
      Number(req.body.price || 0),
      req.body.description || "",
      imageUrl,
      req.params.id
    );

    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});
app.post("/admin/products/:id/delete", auth, (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if (p) {
    db.prepare("DELETE FROM products WHERE id=?").run(req.params.id);
    if (p.image.startsWith("/uploads/")) {
      const file = path.join(__dirname, "public", p.image);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  res.redirect("/admin");
});

app.use((err, req, res, next) => {
  if (err) return res.status(400).send(err.message || "Something went wrong.");
  next();
});

app.listen(PORT, () => console.log(`${STORE_NAME} running on http://localhost:${PORT}`));
