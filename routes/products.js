/* API จัดการข้อมูลสินค้าและสต็อก */
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { checkRole } = require('./auth');

// 1. ดึงประเภทสินค้าทั้งหมด
router.get('/categories', checkRole(['SALES', 'ACCOUNTING', 'INVENTORY', 'ADMIN']), (req, res) => {
  const categories = db.prepare('SELECT * FROM categories').all();
  res.json(categories);
});

// 2. เพิ่มหมวดหมู่สินค้าใหม่
router.post('/categories', checkRole(['INVENTORY', 'ADMIN']), (req, res) => {
  const { categoryCode, categoryName } = req.body;
  if (!categoryCode || !categoryName) {
    return res.status(400).json({ message: 'กรุณากรอกรหัสและชื่อหมวดหมู่' });
  }

  try {
    const exist = db.prepare('SELECT category_id FROM categories WHERE category_code = ?').get(categoryCode.trim().toUpperCase());
    if (exist) return res.status(400).json({ message: `รหัสหมวดหมู่ "${categoryCode}" มีอยู่ในระบบแล้ว` });

    const stmt = db.prepare(`INSERT INTO categories (category_code, category_name) VALUES (?, ?)`);
    const result = stmt.run(categoryCode.trim().toUpperCase(), categoryName.trim());

    res.json({ message: 'เพิ่มหมวดหมู่สินค้าสำเร็จ', categoryId: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 3. ดึงรายการสินค้าทั้งหมด
router.get('/', checkRole(['SALES', 'ACCOUNTING', 'INVENTORY', 'ADMIN']), (req, res) => {
  const products = db.prepare(`
    SELECT p.*, c.category_name, c.category_code 
    FROM products p
    JOIN categories c ON p.category_id = c.category_id
    WHERE p.is_active = 1
    ORDER BY p.product_id DESC
  `).all();
  res.json(products);
});

// 4. ปรับยอดสต็อก
router.post('/adjust', checkRole(['INVENTORY', 'ADMIN']), (req, res) => {
  const { productId, adjustQty, notes } = req.body;
  
  const runTx = db.transaction(() => {
    const product = db.prepare('SELECT stock_quantity FROM products WHERE product_id = ?').get(productId);
    if (!product) throw new Error('ไม่พบสินค้า');

    const newQty = product.stock_quantity + Number(adjustQty);
    if (newQty < 0) throw new Error('สต็อกไม่พอตัด');

    db.prepare('UPDATE products SET stock_quantity = ? WHERE product_id = ?').run(newQty, productId);
    db.prepare(`
      INSERT INTO stock_transactions (product_id, transaction_type, quantity, balance_after, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(productId, adjustQty > 0 ? 'IN' : 'OUT', Math.abs(adjustQty), newQty, notes || 'ปรับยอดสต็อก', req.user.userId);

    return newQty;
  });

  try {
    const remaining = runTx();
    res.json({ message: 'ปรับปรุงสต็อกสำเร็จ', remainingStock: remaining });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 5. เพิ่มสินค้าตัวใหม่ (เก็บแค่ price)
router.post('/add', checkRole(['INVENTORY', 'ADMIN']), (req, res) => {
  const { productCode, productName, categoryId, unit, price, initialQty } = req.body;

  if (!productCode || !productName || !categoryId || !unit) {
    return res.status(400).json({ message: 'กรุณากรอกข้อมูลสินค้าให้ครบถ้วน' });
  }

  const runTx = db.transaction(() => {
    const exist = db.prepare('SELECT product_id FROM products WHERE product_code = ?').get(productCode.trim().toUpperCase());
    if (exist) throw new Error(`รหัสสินค้า "${productCode}" มีอยู่ในระบบแล้ว`);

    const insertStmt = db.prepare(`
      INSERT INTO products (product_code, product_name, category_id, unit, price, stock_quantity)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = insertStmt.run(
      productCode.trim().toUpperCase(),
      productName.trim(),
      parseInt(categoryId, 10),
      unit.trim(),
      parseFloat(price) || 0,
      parseInt(initialQty, 10) || 0
    );

    const newProdId = result.lastInsertRowid;

    if (initialQty && parseInt(initialQty, 10) > 0) {
      db.prepare(`
        INSERT INTO stock_transactions (product_id, transaction_type, quantity, balance_after, notes, created_by)
        VALUES (?, 'IN', ?, ?, 'ยอดยกมาเริ่มต้น', ?)
      `).run(newProdId, initialQty, initialQty, req.user.userId);
    }

    return newProdId;
  });

  try {
    const newId = runTx();
    res.json({ message: 'เพิ่มสินค้าใหม่เรียบร้อยแล้ว', productId: newId });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 6. แก้ไขข้อมูลสินค้า
router.put('/:id', checkRole(['INVENTORY', 'ADMIN']), (req, res) => {
  const { id } = req.params;
  const { productCode, productName, categoryId, unit, price, sellingPrice } = req.body;

  // เลือกว่าส่ง price หรือ sellingPrice มา
  const finalPrice = price !== undefined ? price : sellingPrice;

  if (!productCode || !productName || !categoryId || !unit) {
    return res.status(400).json({ message: 'กรุณากรอกข้อมูลสินค้าให้ครบถ้วน' });
  }

  try {
    const exist = db.prepare('SELECT product_id FROM products WHERE product_code = ? AND product_id != ?')
      .get(productCode.trim().toUpperCase(), id);
    if (exist) return res.status(400).json({ message: `รหัสสินค้า "${productCode}" ซ้ำกับสินค้าตัวอื่นในระบบ` });

    // ตรวจสอบว่าใน database ใช้คอลัมน์ชื่อ price หรือ selling_price
    // หากเปลี่ยนเป็น price แล้ว ให้ใช้ UPDATE products SET ..., price = ?
    const stmt = db.prepare(`
      UPDATE products 
      SET product_code = ?, product_name = ?, category_id = ?, unit = ?, price = ?
      WHERE product_id = ?
    `);

    stmt.run(
      productCode.trim().toUpperCase(),
      productName.trim(),
      parseInt(categoryId, 10),
      unit.trim(),
      parseFloat(finalPrice) || 0,
      id
    );

    res.json({ message: 'แก้ไขข้อมูลสินค้าสำเร็จ' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 7. ลบสินค้า (ลบออกจากฐานข้อมูลถาวร)
router.delete('/:id', checkRole(['INVENTORY', 'ADMIN']), (req, res) => {
  const { id } = req.params;
  try {
    const prod = db.prepare('SELECT product_name FROM products WHERE product_id = ?').get(id);
    if (!prod) return res.status(404).json({ message: 'ไม่พบสินค้า' });

    // ลบรายการออกจากฐานข้อมูลจริง
    db.prepare('DELETE FROM products WHERE product_id = ?').run(id);

    res.json({ message: `ลบสินค้า "${prod.product_name}" สำเร็จเรียบร้อยแล้ว` });
  } catch (err) {
    // ป้องกันกรณีสินค้ามีประวัติบิลขายเดิมผูกอยู่ (ติด Foreign Key)
    if (err.message.includes('FOREIGN KEY constraint failed')) {
      db.prepare('UPDATE products SET is_active = 0 WHERE product_id = ?').run(id);
      return res.json({ message: `สินค้านี้เคยมีประวัติเปิดบิลแล้ว ระบบได้ทำการซ่อนสินค้าแทนการลบถาวร` });
    }
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;