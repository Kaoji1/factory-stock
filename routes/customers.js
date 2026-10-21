const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { checkRole } = require('./auth');

// 1. ดึงรายชื่อลูกค้าพร้อมสรุปยอดหนี้และจำนวนบิลค้างชำระ
router.get('/debt-summary', checkRole(['ACCOUNTING', 'ADMIN']), (req, res) => {
  try {
    const summary = db.prepare(`
      SELECT 
        c.customer_id,
        c.customer_code,
        c.customer_name,
        c.phone,
        c.credit_limit,
        c.current_debt,
        (SELECT COUNT(*) FROM sales_bills WHERE customer_id = c.customer_id AND payment_status = 'UNPAID') AS unpaid_bills_count
      FROM customers c
      WHERE c.is_active = 1
      ORDER BY c.current_debt DESC
    `).all();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ ย้าย /all-bills มาไว้ตรงนี้ (ก่อน /:customerId เสมอ เพื่อไม่ให้ Express สับสน)
router.get('/all-bills', checkRole(['ACCOUNTING', 'ADMIN']), (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT 
        sb.bill_id,
        sb.book_no,
        sb.bill_no,
        sb.bill_date,
        sb.grand_total,
        sb.payment_status,
        sb.payment_method,
        sb.created_at,
        c.customer_code,
        c.customer_name
      FROM sales_bills sb
      LEFT JOIN customers c ON sb.customer_id = c.customer_id
      WHERE 1=1
    `;
    let params = [];
    if (status && status !== '') {
      query += ` AND sb.payment_status = ?`;
      params.push(status);
    }
    query += ` ORDER BY sb.bill_id DESC`;
    const bills = db.prepare(query).all(...params);
    res.json(bills);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 2. ดึงรายการบิลทั้งหมดของลูกค้ารายบุคคล (อยู่ถัดลงมา)
router.get('/:customerId/bills', checkRole(['ACCOUNTING', 'ADMIN']), (req, res) => {
  const { customerId } = req.params;
  try {
    const bills = db.prepare(`
      SELECT 
        bill_id,
        book_no,
        bill_no,
        bill_date,
        grand_total,
        payment_status,
        payment_method,
        created_at
      FROM sales_bills
      WHERE customer_id = ?
      ORDER BY bill_id DESC
    `).all(customerId);
    res.json(bills);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 3. บันทึกรับชำระเงินบิล
router.post('/pay-bill', checkRole(['ACCOUNTING', 'ADMIN']), (req, res) => {
  const { billId } = req.body;

  const runTx = db.transaction(() => {
    const bill = db.prepare(`SELECT * FROM sales_bills WHERE bill_id = ?`).get(billId);
    if (!bill) throw new Error('ไม่พบข้อมูลบิล');
    if (bill.payment_status === 'PAID') throw new Error('บิลนี้ได้รับการชำระเงินแล้ว');

    db.prepare(`
      UPDATE sales_bills 
      SET payment_status = 'PAID', payment_method = 'TRANSFER' 
      WHERE bill_id = ?
    `).run(billId);

    db.prepare(`
      UPDATE customers 
      SET current_debt = MAX(0, current_debt - ?) 
      WHERE customer_id = ?
    `).run(bill.grand_total, bill.customer_id);

    return { billNo: bill.bill_no, amount: bill.grand_total };
  });

  try {
    const result = runTx();
    res.json({ message: `รับชำระเงินบิลเลขที่ ${result.billNo} จำนวน ${result.amount.toLocaleString()} บาท สำเร็จแล้ว` });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// 4. เพิ่มลูกค้าใหม่เข้าสู่ระบบ
router.post('/add', checkRole(['SALES', 'ADMIN']), (req, res) => {
  const { customerCode, customerName, taxId, address, phone, creditLimit } = req.body;

  if (!customerName) {
    return res.status(400).json({ message: 'กรุณากรอกชื่อลูกค้า/บริษัท' });
  }

  try {
    let finalCode = customerCode ? customerCode.trim().toUpperCase() : null;

    if (!finalCode) {
      const lastCust = db.prepare('SELECT customer_id FROM customers ORDER BY customer_id DESC LIMIT 1').get();
      const nextId = (lastCust ? lastCust.customer_id : 0) + 1;
      finalCode = `CUST-${nextId.toString().padStart(3, '0')}`;
    } else {
      const exist = db.prepare('SELECT customer_id FROM customers WHERE customer_code = ?').get(finalCode);
      if (exist) {
        return res.status(400).json({ message: `รหัสลูกค้า "${finalCode}" มีอยู่ในระบบแล้ว` });
      }
    }

    const stmt = db.prepare(`
      INSERT INTO customers (customer_code, customer_name, tax_id, address, phone, credit_limit, current_debt, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1)
    `);

    const result = stmt.run(
      finalCode,
      customerName.trim(),
      taxId ? taxId.trim() : '',
      address ? address.trim() : '',
      phone ? phone.trim() : '',
      parseFloat(creditLimit) || 0
    );

    res.json({
      message: 'เพิ่มลูกค้าใหม่สำเร็จ',
      customerId: result.lastInsertRowid,
      customerCode: finalCode,
      customerName: customerName.trim(),
      taxId: taxId ? taxId.trim() : '',
      address: address ? address.trim() : '',
      phone: phone ? phone.trim() : ''
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ดึงข้อมูลลูกค้ารายบุคคล
router.get('/:customerId', checkRole(['SALES', 'ACCOUNTING', 'ADMIN']), (req, res) => {
  const { customerId } = req.params;
  const customer = db.prepare('SELECT * FROM customers WHERE customer_id = ? AND is_active = 1').get(customerId);
  if (!customer) return res.status(404).json({ message: 'ไม่พบข้อมูลลูกค้า' });
  res.json(customer);
});

// แก้ไขข้อมูลลูกค้า
router.put('/:customerId', checkRole(['SALES', 'ADMIN']), (req, res) => {
  const { customerId } = req.params;
  const { customerCode, customerName, taxId, address, phone, creditLimit } = req.body;

  if (!customerName) {
    return res.status(400).json({ message: 'กรุณากรอกชื่อลูกค้า' });
  }

  try {
    const exist = db.prepare('SELECT customer_id FROM customers WHERE customer_code = ? AND customer_id != ?')
      .get(customerCode.trim().toUpperCase(), customerId);
    if (exist) {
      return res.status(400).json({ message: `รหัสลูกค้า "${customerCode}" ซ้ำกับลูกค้ารายอื่น` });
    }

    db.prepare(`
      UPDATE customers 
      SET customer_code = ?, customer_name = ?, tax_id = ?, address = ?, phone = ?, credit_limit = ?
      WHERE customer_id = ?
    `).run(
      customerCode.trim().toUpperCase(),
      customerName.trim(),
      taxId ? taxId.trim() : '',
      address ? address.trim() : '',
      phone ? phone.trim() : '',
      parseFloat(creditLimit) || 0,
      customerId
    );

    res.json({ message: 'แก้ไขข้อมูลลูกค้าสำเร็จ' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ลบลูกค้า
router.delete('/:customerId', checkRole(['SALES', 'ADMIN']), (req, res) => {
  const { customerId } = req.params;

  try {
    const cust = db.prepare('SELECT customer_name, current_debt FROM customers WHERE customer_id = ?').get(customerId);
    if (!cust) return res.status(404).json({ message: 'ไม่พบข้อมูลลูกค้า' });

    if (cust.current_debt > 0) {
      return res.status(400).json({ 
        message: `ไม่สามารถลบได้ เนื่องจากลูกค้า "${cust.customer_name}" ยังมียอดหนี้ค้างชำระอยู่ ${cust.current_debt.toLocaleString()} บาท` 
      });
    }

    db.prepare('UPDATE customers SET is_active = 0 WHERE customer_id = ?').run(customerId);
    res.json({ message: `ลบลูกค้า "${cust.customer_name}" เรียบร้อยแล้ว` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;