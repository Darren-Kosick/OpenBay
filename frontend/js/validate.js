// Form checks done in the browser. The server checks everything again.

export const PROVINCES = ['ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE', 'YT', 'NT', 'NU', 'Other'];

export const normPlate = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function luhn(digits) {
  let sum = 0, double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export const cardBrand = (n) =>
  /^4/.test(n) ? 'Visa' : /^(5[1-5]|2[2-7])/.test(n) ? 'Mastercard' : /^3[47]/.test(n) ? 'Amex' : 'Card';

/** Checks a card form. Returns only what is sent to the server: the full number and CVC never leave the device. */
export function parseCard(d) {
  const number = String(d.number || '').replace(/\D/g, '');
  if (!String(d.holder || '').trim()) throw new Error('Enter the name on the card.');
  if (number.length < 13 || number.length > 19 || !luhn(number)) throw new Error('That card number is not valid.');
  const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(String(d.expiry || '').trim());
  if (!m || +m[1] < 1 || +m[1] > 12) throw new Error('Enter the expiry as MM/YY.');
  const now = new Date();
  if ((2000 + +m[2]) * 12 + +m[1] < now.getFullYear() * 12 + now.getMonth() + 1) throw new Error('That card has expired.');
  if (!/^\d{3,4}$/.test(String(d.cvc || '').trim())) throw new Error('Enter the 3 or 4 digit security code.');
  return { brand: cardBrand(number), last4: number.slice(-4), expiry: `${m[1]}/${m[2]}`, holder: d.holder.trim() };
}

export function parseVehicle(d) {
  const plate = normPlate(d.plate);
  if (plate.length < 2 || plate.length > 8) throw new Error('Enter a licence plate of 2 to 8 letters and numbers.');
  if (!String(d.make || '').trim()) throw new Error('Enter the vehicle make.');
  return {
    plate,
    province: d.province || 'ON',
    make: d.make.trim(),
    model: String(d.model || '').trim(),
    colour: String(d.colour || '').trim(),
  };
}

export function checkAccount(d) {
  if (!String(d.name || '').trim()) throw new Error('Enter your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(d.email || '').trim())) throw new Error('Enter a valid email address.');
  if (String(d.password || '').length < 8) throw new Error('Use a password of at least 8 characters.');
}
