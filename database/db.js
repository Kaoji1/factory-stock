// database/db.js
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, '../database.sqlite'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 1. สร้างตารางทั้งหมด
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    role_id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_code TEXT UNIQUE NOT NULL,
    role_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role_id INTEGER NOT NULL,
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (role_id) REFERENCES roles(role_id)
  );

  CREATE TABLE IF NOT EXISTS categories (
    category_id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_code TEXT UNIQUE NOT NULL,
    category_name TEXT NOT NULL
  );

  -- ตัด cost_price ออก เหลือแค่ price ตัวเดียว
  CREATE TABLE IF NOT EXISTS products (
    product_id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code TEXT UNIQUE NOT NULL,
    product_name TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    unit TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    stock_quantity INTEGER DEFAULT 0 CHECK (stock_quantity >= 0),
    is_active INTEGER DEFAULT 1,
    FOREIGN KEY (category_id) REFERENCES categories(category_id)
  );

  CREATE TABLE IF NOT EXISTS customers (
    customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_code TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    tax_id TEXT,
    address TEXT,
    phone TEXT,
    credit_limit REAL DEFAULT 0,
    current_debt REAL DEFAULT 0,
    is_credit_hold INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS sales_bills (
    bill_id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_no TEXT DEFAULT '1',
    bill_no TEXT UNIQUE NOT NULL,
    bill_date TEXT NOT NULL,
    customer_id INTEGER NOT NULL,
    subtotal REAL NOT NULL,
    has_vat INTEGER DEFAULT 1,
    vat_amount REAL NOT NULL,
    grand_total REAL NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'UNPAID',
    payment_method TEXT DEFAULT 'CREDIT',
    created_by INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
    FOREIGN KEY (created_by) REFERENCES users(user_id)
  );

  CREATE TABLE IF NOT EXISTS sales_bill_items (
    item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    bill_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    unit_price REAL NOT NULL,
    amount REAL NOT NULL,
    FOREIGN KEY (bill_id) REFERENCES sales_bills(bill_id),
    FOREIGN KEY (product_id) REFERENCES products(product_id)
  );

  CREATE TABLE IF NOT EXISTS stock_transactions (
    transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    notes TEXT,
    created_by INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (product_id) REFERENCES products(product_id),
    FOREIGN KEY (created_by) REFERENCES users(user_id)
  );
`);

// 2. ข้อมูล Roles & Users เริ่มต้น
const insertRole = db.prepare(`INSERT OR IGNORE INTO roles (role_id, role_code, role_name) VALUES (?, ?, ?)`);
insertRole.run(1, 'ADMIN', 'ผู้ดูแลระบบ');
insertRole.run(2, 'SALES', 'ฝ่ายขาย');
insertRole.run(3, 'ACCOUNTING', 'ฝ่ายบัญชี');
insertRole.run(4, 'INVENTORY', 'ฝ่ายสต็อก');

const defaultPass = bcrypt.hashSync('123456', 10);
const insertUser = db.prepare(`INSERT OR IGNORE INTO users (user_id, username, password_hash, full_name, role_id) VALUES (?, ?, ?, ?, ?)`);
insertUser.run(1, 'admin', defaultPass, 'ผู้ดูแลระบบ', 1);
insertUser.run(2, 'sales01', defaultPass, 'สมชาย ฝ่ายขาย', 2);
insertUser.run(3, 'acc01', defaultPass, 'สมหญิง ฝ่ายบัญชี', 3);
insertUser.run(4, 'stock01', defaultPass, 'สมศักดิ์ ฝ่ายสต็อก', 4);

// 3. หมวดหมู่สินค้า
const insertCategory = db.prepare(`INSERT OR IGNORE INTO categories (category_id, category_code, category_name) VALUES (?, ?, ?)`);
insertCategory.run(1, 'BRICK', 'อิฐบล็อก');
insertCategory.run(2, 'POLE', 'เสารั้ว');

// 4. สินค้าตั้งต้น (เหลือเฉพาะ price)
const insertProduct = db.prepare(`
  INSERT OR IGNORE INTO products (product_id, product_code, product_name, category_id, unit, price, stock_quantity)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
insertProduct.run(1, 'BRK-01', 'อิฐบล็อก 7 ซม. (ตัน)', 1, 'ก้อน', 3.60, 500);
insertProduct.run(2, 'BRK-02', 'อิฐบล็อก 7 ซม. (มอก58-2560)', 1, 'ก้อน', 5.00, 500);
insertProduct.run(3, 'BRK-03', 'อิฐบล็อก 9 ซม. (มอก58-2560)', 1, 'ก้อน', 7.90, 300);
insertProduct.run(4, 'BRK-04', 'อิฐบล็อก 14 ซม. (มอก58-2560)', 1, 'ก้อน', 12.60, 200);
insertProduct.run(5, 'BRK-05', 'อิฐบล็อก 19 ซม. (มอก58-2560)', 1, 'ก้อน', 21.00, 150);

// 5. ข้อมูลลูกค้าตัวอย่าง
const insertCustomer = db.prepare(`
  INSERT OR IGNORE INTO customers (customer_id, customer_code, customer_name, tax_id, address, phone, credit_limit, current_debt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
insertCustomer.run(
  1, 
  'CUST-001', 
  'บริษัท นอร์ธแลนด์ดีเวลลอปเม้นต์ จำกัด (สำนักงานใหญ่ 00000)', 
  '0195538000370', 
  '110 หมู่ 8 ถนนแก่งคอย - บ้านนา ตำบลตาลเดี่ยว อำเภอแก่งคอย จังหวัดสระบุรี 18110', 
  '036-358318', 
  200000, 
  0
);

module.exports = db;