// Builds default_vendor.json: the sample vendor a fresh install (and the Vercel demo) starts with.
// It only writes that one file. It never touches the live data in ./data.
// Everything here is sample data: prices, PAN and bank details are made up.
const fs = require('fs'), path = require('path');

const addr = 'No 61, South Mada Street\nThiruvanmiyur\nChennai - 600041';
const SAC = '9963'; // food and beverage serving services
// name, rate, unit
const items = [
  ['Channa samosa', 35, 'pcs'], ['Pani puri', 47, 'plate'], ['Peanut salad', 52, 'cup'], ['Breakfast combo', 280, 'box'],
  ['Veg burger', 60, 'pcs'], ['Fruit salad', 60, 'cup'], ['Veg masala sandwich', 42, 'pcs'], ['Mushroom samosa', 47, 'pcs'],
  ['Gobi pakora', 60, 'plate'], ['Medu vada (2) & Bonda (2)', 52, 'plate'], ['Panneer puff', 60, 'pcs'], ['Sambar vada', 60, 'plate'],
  ['Paneer samosa', 45, 'pcs'], ['Medu pakoda', 50, 'plate'], ['Masala bonda', 40, 'plate'], ['Garden fresh sandwich', 45, 'pcs'],
  ['Spl. bun butter jam', 35, 'pcs'], ['Green gram sundal', 40, 'cup'], ['Set dosa', 70, 'plate'], ['Norukkal', 55, 'plate'],
  ['Mixed nuts', 80, 'cup'], ['Palkova poli', 45, 'pcs'], ['Filter coffee', 25, 'cup'], ['Tea', 20, 'cup'], ['Lemon juice', 30, 'cup'],
];
const cust = [
  { id: 'c1', name: 'MK Enterprise', address: '4th Floor, No.33B, Karthigai St.\nRajalakshmi Nagar,\nMoulivakkam,\nChennai – 600125 TN India', shipAddress: '', gst: '33JRCPS6156P1ZY' },
  { id: 'c2', name: 'Global Tech Park Canteen', address: 'Tech Park Road, Perungudi,\nChennai – 600096 TN India', shipAddress: 'Food Court, Block B, Ground Floor\nTech Park Road, Perungudi,\nChennai – 600096 TN India', gst: '33AABCG5678B1Z2' },
];
const rateOf = n => items.find(i => i[0] === n)[1];
const party = (cu, ship) => ({ name: cu.name, address: ship && cu.shipAddress ? cu.shipAddress : cu.address, gst: cu.gst });
// the two older bills use the simple format (no unit / HSN), like invoices made before those columns existed
const mk = (id, no, date, cu, list, status, paidDate) => ({
  id, no, date, customerId: cu.id, billTo: party(cu), shipTo: party(cu, true),
  lines: list.map(([d, n, c]) => ({ date: d, item: n, count: c, cost: rateOf(n) })),
  gstRate: 5, status, paidDate,
});
// demo bill with 25 lines: every item once, with unit and SAC code, and a discount on two bulk lines
const big = {
  id: 'inv103', no: 'SP.103', date: '2026-11-14', customerId: cust[1].id, billTo: party(cust[1]), shipTo: party(cust[1], true),
  lines: items.map(([n, r, u], k) => {
    const l = { date: `2026-11-${String(2 + Math.floor(k / 2)).padStart(2, '0')}`, item: n, hsn: SAC, count: 20 + (k * 7) % 45, unit: u, cost: r };
    if (k === 3 || k === 18) l.disc = 5;
    return l;
  }),
  gstRate: 5, taxType: 'intra', discount: 0, status: 'unpaid', paidDate: '',
};
const ws = {
  settings: {
    name: 'Salt & Pepper Food Chain', address: addr, phone: '9363536154', gst: '33MHHPK2569J1ZU', pan: 'ABCPL1234F', logo: 'logo.png', themeColor: '#3b82f6',
    prefix: 'SP.', nextNo: 104, gstRate: 5, dueDays: 10, bankAccount: '123456789012', ifsc: 'SBIN0001234', bankName: 'State Bank of India',
    accountName: 'Salt & Pepper Food Chain', terms: 'Payment should be made within 10 days from the date of invoice only to the account below.',
  },
  customers: cust,
  items: items.map(([name, rate, unit], i) => ({ id: 'i' + (i + 1), name, details: '', hsn: SAC, unit, rate, gst: '' })),
  invoices: [
    mk('inv101', 'SP.101', '2026-09-30', cust[0], [['2026-09-01', 'Channa samosa', 40], ['2026-09-03', 'Pani puri', 55], ['2026-09-04', 'Breakfast combo', 12], ['2026-09-08', 'Veg burger', 48], ['2026-09-10', 'Fruit salad', 50], ['2026-09-15', 'Gobi pakora', 52]], 'paid', '2026-10-06'),
    mk('inv102', 'SP.102', '2026-10-31', cust[0], [['2026-10-01', 'Channa samosa', 46], ['2026-10-05', 'Pani puri', 57], ['2026-10-06', 'Peanut salad', 40], ['2026-10-07', 'Veg burger', 45], ['2026-10-12', 'Veg masala sandwich', 54], ['2026-10-14', 'Gobi pakora', 58], ['2026-10-20', 'Panneer puff', 56], ['2026-10-26', 'Sambar vada', 55]], 'unpaid', ''),
    big,
  ],
};
fs.writeFileSync(path.join(__dirname, 'default_vendor.json'), JSON.stringify(ws, null, 2));
console.log('default_vendor.json written:', ws.items.length, 'items,', ws.invoices.length, 'invoices, demo bill', big.no, 'has', big.lines.length, 'lines');
