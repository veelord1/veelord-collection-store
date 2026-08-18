
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;
const STORE_NAME = process.env.STORE_NAME || "Veelord Collection & Gift Store";
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || "2349130051086").replace(/\D/g, "");

const dataDir = path.join(__dirname, "data");
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
`);

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

app.get("/", (req, res) => {
  const category = req.query.category || "";
  const q = (req.query.q || "").trim();
  let sql = "SELECT * FROM products";
  const params = [];
  const where = [];
  if (category) { where.push("category=?"); params.push(category); }
  if (q) { where.push("(name LIKE ? OR description LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY id DESC";
  const products = db.prepare(sql).all(...params).map(p => ({...p, wa: waLink(p)}));
  const categories = db.prepare("SELECT DISTINCT category FROM products ORDER BY category").all().map(x => x.category);
  res.render("index", { storeName: STORE_NAME, products, categories, activeCategory: category, q });
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

app.post("/admin/products", auth, upload.single("image"), (req, res) => {
  const { name, category, price, description } = req.body;
  if (!name || !category || !req.file) return res.status(400).send("Name, category and image are required.");
  db.prepare("INSERT INTO products(name,category,price,description,image) VALUES (?,?,?,?,?)")
    .run(name, category, Number(price || 0), description || "", "/uploads/" + req.file.filename);
  res.redirect("/admin");
});

app.post("/admin/products/:id/edit", auth, upload.single("image"), (req, res) => {
  const old = db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if (!old) return res.status(404).send("Product not found.");
  const image = req.file ? "/uploads/" + req.file.filename : old.image;
  db.prepare("UPDATE products SET name=?,category=?,price=?,description=?,image=? WHERE id=?")
    .run(req.body.name, req.body.category, Number(req.body.price || 0), req.body.description || "", image, req.params.id);
  if (req.file && old.image.startsWith("/uploads/")) {
    const oldPath = path.join(__dirname, "public", old.image);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  res.redirect("/admin");
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
