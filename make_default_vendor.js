// Builds default_vendor.json (sample vendor modelled on the reference bill) and applies it to the existing vendor1 workspace.
const fs = require('fs'), path = require('path');
const addr = 'No 12, Anna Salai\nTeynampet\nChennai - 600018';
const items = [['Channa samosa',35],['Pani puri',47],['Peanut salad',52],['Breakfast combo',280],['Veg burger',60],['Fruit salad',60],['Veg masala sandwich',42],['Mushroom samosa',47],['Gobi pakora',60],['Medu vada (2) & Bonda (2)',52],['Panneer puff',60],['Sambar vada',60]];
const cust = [
  { id: 'c1', name: 'MK Enterprise', address: '4th Floor, No.33B, Karthigai St.\nRajalakshmi Nagar,\nMoulivakkam,\nChennai – 600125 TN India', gst: '33JRCPS6156P1ZY' },
  { id: 'c2', name: 'Global Tech Park Canteen', address: 'Tech Park Road, Perungudi,\nChennai – 600096 TN India', gst: '33AABCG5678B1Z2' },
];
const mk = (id, no, date, cu, list, status, paidDate) => ({ id, no, date, customerId: cu.id,
  billTo: { name: cu.name, address: cu.address, gst: cu.gst }, shipTo: { name: cu.name, address: cu.address, gst: cu.gst },
  lines: list.map(([d, n, c]) => ({ date: d, item: items.find(i => i[0] === n)[0], count: c, cost: items.find(i => i[0] === n)[1] })),
  gstRate: 5, status, paidDate });
const ws = {
  settings: { name: 'Sri Lakshmi Caterers', address: addr, phone: '9876543210', gst: '33ABCPL1234F1Z5', pan: 'ABCPL1234F', logo: '', themeColor: '#f4e36b',
    prefix: 'SLC.', nextNo: 103, gstRate: 5, dueDays: 10, bankAccount: '123456789012', ifsc: 'SBIN0001234', bankName: 'State Bank of India',
    accountName: 'Sri Lakshmi Caterers', terms: 'Payment should be made within 10 days from the date of invoice only to the account below.' },
  customers: cust,
  items: items.map((x, i) => ({ id: 'i' + (i + 1), name: x[0], details: '', rate: x[1] })),
  invoices: [
    mk('inv101', 'SLC.101', '2026-09-30', cust[0], [['2026-09-01','Channa samosa',40],['2026-09-03','Pani puri',55],['2026-09-04','Breakfast combo',12],['2026-09-08','Veg burger',48],['2026-09-10','Fruit salad',50],['2026-09-15','Gobi pakora',52]], 'paid', '2026-10-06'),
    mk('inv102', 'SLC.102', '2026-10-31', cust[0], [['2026-10-01','Channa samosa',46],['2026-10-05','Pani puri',57],['2026-10-06','Peanut salad',40],['2026-10-07','Veg burger',45],['2026-10-12','Veg masala sandwich',54],['2026-10-14','Gobi pakora',58],['2026-10-20','Panneer puff',56],['2026-10-26','Sambar vada',55]], 'unpaid', ''),
  ],
};
fs.writeFileSync(path.join(__dirname, 'default_vendor.json'), JSON.stringify(ws, null, 2));
const users = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/users.json'), 'utf8'));
const v = users.find(u => u.username === 'vendor1');
if (v) { v.name = ws.settings.name; fs.writeFileSync(path.join(__dirname, 'data/users.json'), JSON.stringify(users, null, 2)); fs.writeFileSync(path.join(__dirname, 'data/ws_' + v.id + '.json'), JSON.stringify(ws, null, 2)); console.log('updated', v.id); }
