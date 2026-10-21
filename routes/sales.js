/* API เปิดบิลขาย, ตัดสต็อก, คำนวณ VAT */
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { checkRole } = require('./auth');

// 1. ดึงเล่มที่ และเลขที่บิลถัดไป (รันรูปแบบ YY + เลขรัน 3 หลัก เช่น 69001)
router.get('/next-bill-no', checkRole(['SALES', 'ADMIN']), (req, res) => {
  // 1. หาปี พ.ศ. ปัจจุบัน และดึงเลขท้าย 2 ตัว (เช่น 2569 -> "69")
  const currentYearBE = new Date().getFullYear() + 543;
  const yearPrefix = currentYearBE.toString().slice(-2);

  // 2. ดึงบิลล่าสุดที่เคยบันทึกไว้
  const lastBill = db.prepare(`
    SELECT book_no, bill_no, bill_date, created_at 
    FROM sales_bills 
    ORDER BY bill_id DESC 
    LIMIT 1
  `).get();

  let nextBookNo = 1;
  let nextBillNo = `${yearPrefix}001`; // ค่าเริ่มต้นถ้ายังไม่เคยมีบิลเลย

  if (lastBill) {
    let lastYear = null;

    if (lastBill.created_at) {
      lastYear = new Date(lastBill.created_at).getFullYear() + 543;
    } else if (lastBill.bill_date) {
      const match = lastBill.bill_date.match(/\d{4}$/);
      if (match) lastYear = parseInt(match[0], 10);
    }

    const currentBook = parseInt(lastBill.book_no, 10) || 1;

    // 3. ตรวจสอบว่าขึ้นปีใหม่หรือยัง
    if (lastYear && currentYearBE > lastYear) {
      // ข้ามปีใหม่: เล่มที่ +1 และเริ่มเลขบิลใหม่ที่ YY001 (เช่น 70001)
      nextBookNo = currentBook + 1;
      nextBillNo = `${yearPrefix}001`;
    } else {
      // อยู่ในปีเดิม: ใช้เล่มเดิม
      nextBookNo = currentBook;

      const lastBillStr = lastBill.bill_no ? lastBill.bill_no.toString() : '';

      // เช็คว่าบิลล่าสุดขึ้นต้นด้วยปีปัจจุบัน (เช่น "69") หรือไม่
      if (lastBillStr.startsWith(yearPrefix) && lastBillStr.length >= 5) {
        // ดึงตัวเลขลำดับ 3 หลักท้ายมาบวกเพิ่ม 1
        const runningNum = parseInt(lastBillStr.slice(2), 10) + 1;
        nextBillNo = `${yearPrefix}${runningNum.toString().padStart(3, '0')}`;
      } else {
        // หากรูปแบบเดิมยังไม่ใช่ ให้เริ่มนับ 001 ของปีปัจจุบันทันที
        nextBillNo = `${yearPrefix}001`;
      }
    }
  }

  res.json({
    bookNo: nextBookNo.toString(),
    nextBillNo: nextBillNo
  });
});

// 2. ดึงรายชื่อลูกค้าทั้งหมด (เพิ่ม customer_code และ credit_limit)
router.get('/customers-list', checkRole(['SALES', 'ACCOUNTING', 'ADMIN']), (req, res) => {
  const customers = db.prepare(`
    SELECT 
      customer_id, 
      customer_code, 
      customer_name, 
      tax_id, 
      address, 
      phone, 
      credit_limit 
    FROM customers 
    WHERE is_active = 1
    ORDER BY customer_id ASC
  `).all();
  res.json(customers);
});

// 3. API บันทึกบิลขาย + ตัดสต็อก + อัปเดตยอดหนี้ลูกค้า (ถ้ายังไม่จ่าย)
router.post('/create-bill', checkRole(['SALES', 'ADMIN']), (req, res) => {
  const { 
    bookNo, billNo, billDate, customerId, items, 
    subtotal, hasVat, vatAmount, grandTotal,
    paymentStatus = 'UNPAID',  // ใส่ค่าเริ่มต้นเป็น UNPAID ถ้าไม่ได้ส่งมา
    paymentMethod = 'CREDIT'   // ใส่ค่าเริ่มต้นเป็น CREDIT
  } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ message: 'กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ' });
  }

  const runTx = db.transaction(() => {
    // 1. บันทึกหัวบิลพร้อมสถานะจ่ายเงิน
    const billStmt = db.prepare(`
      INSERT INTO sales_bills (
        book_no, bill_no, bill_date, customer_id, 
        subtotal, has_vat, vat_amount, grand_total, 
        payment_status, payment_method, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const billResult = billStmt.run(
      bookNo, billNo, billDate, customerId, 
      subtotal, hasVat ? 1 : 0, vatAmount, grandTotal, 
      paymentStatus, paymentMethod, req.user.userId
    );
    const billId = billResult.lastInsertRowid;

    // 2. ถ้าสถานะเป็น "ยังไม่จ่าย (UNPAID)" -> เพิ่มยอดหนี้สะสมให้ลูกค้าทันที
    if (paymentStatus === 'UNPAID') {
      db.prepare(`
        UPDATE customers 
        SET current_debt = current_debt + ? 
        WHERE customer_id = ?
      `).run(grandTotal, customerId);
    }

    // 3. บันทึกรายการสินค้า ตัดสต็อก และบันทึกประวัติ (Log)
    const itemStmt = db.prepare(`
      INSERT INTO sales_bill_items (bill_id, product_id, item_name, quantity, unit, unit_price, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const updateStockStmt = db.prepare(`
      UPDATE products 
      SET stock_quantity = stock_quantity - ? 
      WHERE product_id = ?
    `);

    const stockTxStmt = db.prepare(`
      INSERT INTO stock_transactions (product_id, transaction_type, quantity, balance_after, notes, created_by)
      VALUES (?, 'OUT', ?, ?, ?, ?)
    `);

    for (const itm of items) {
      const prod = db.prepare('SELECT stock_quantity, product_name FROM products WHERE product_id = ?').get(itm.productId);
      if (!prod || prod.stock_quantity < itm.quantity) {
        throw new Error(`สินค้า "${itm.itemName || prod?.product_name}" สต็อกไม่พอ (คงเหลือ ${prod?.stock_quantity || 0})`);
      }

      const balanceAfter = prod.stock_quantity - Number(itm.quantity);

      itemStmt.run(billId, itm.productId, itm.itemName, itm.quantity, itm.unit, itm.unitPrice, itm.amount);
      updateStockStmt.run(itm.quantity, itm.productId);
      stockTxStmt.run(itm.productId, itm.quantity, balanceAfter, `เปิดบิลขาย เล่มที่ ${bookNo} เลขที่ ${billNo}`, req.user.userId);
    }

    return billId;
  });

  try {
    const newBillId = runTx();
    res.json({ message: 'บันทึกบิลและตัดสต็อกสำเร็จ', billId: newBillId });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 4. API ดึงรายงานสรุปยอดขายตามช่วงวันที่ หรือรายเดือน (รองรับการเทียบวันที่สากลและวันที่ภาษาไทย)
router.get('/report', checkRole(['SALES', 'ACCOUNTING', 'ADMIN']), (req, res) => {
  try {
    const { startDate, endDate, month, status } = req.query;
    
    let query = `
      SELECT sb.*, c.customer_name 
      FROM sales_bills sb
      LEFT JOIN customers c ON sb.customer_id = c.customer_id
      WHERE 1=1
    `;
    let params = [];

    // 1. กรองตามสถานะการชำระเงิน (ถ้ามี)
    if (status && status !== '') {
      query += ` AND sb.payment_status = ?`;
      params.push(status);
    }

    // 2. กรองตามเงื่อนไขเวลา
    if (month) {
      // ค้นหาตามเดือน (รูปแบบ YYYY-MM) แปลงเดือนภาษาไทยหรือสากล
      query += ` AND (strftime('%Y-%m', sb.created_at) = ? OR sb.bill_date LIKE ?)`;
      params.push(month, `%${month}%`); // รองรับกรณีย่อหรือเทียบเดือน
    } else if (startDate && endDate) {
      // แปลงช่วงวันที่ YYYY-MM-DD ให้ครอบคลุมการค้นหา
      query += ` AND (DATE(sb.created_at) BETWEEN ? AND ? OR sb.bill_date LIKE ? OR sb.bill_date LIKE ?)`;
      // เผื่อกรณีค้นหาเทียบช่วงวันตรงๆ
      params.push(startDate, endDate, `%${startDate}%`, `%${endDate}%`);
    }

    query += ` ORDER BY sb.bill_id DESC`;

    const rows = db.prepare(query).all(...params);

    // คำนวณผลรวมยอดสุทธิและภาษี VAT
    let totalAmount = 0;
    let totalVat = 0;

    rows.forEach(row => {
      totalAmount += parseFloat(row.grand_total || 0);
      totalVat += parseFloat(row.vat_amount || 0);
    });

    res.json({
      bills: rows,
      totalBills: rows.length,
      totalAmount: totalAmount,
      totalVat: totalVat
    });

  } catch (err) {
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในการดึงรายงาน: ' + err.message });
  }
});

module.exports = router;