const express = require('express');
const cors = require('cors');
const path = require('path');

const { router: authRouter } = require('./routes/auth');
const productsRouter = require('./routes/products');
const customersRouter = require('./routes/customers');
const salesRouter = require('./routes/sales');

const app = express();
app.use(cors());
app.use(express.json());

// เปิดไฟล์หน้าเว็บในโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

// ใช้งาน Routes
app.use('/api/auth', authRouter);
app.use('/api/products', productsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/sales', salesRouter);

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});