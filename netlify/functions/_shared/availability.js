const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function cleanBooked(input) {
  return [...new Set((Array.isArray(input) ? input : []).filter(isIsoDate))].sort();
}

export function parseBookedInput(input) {
  if (!Array.isArray(input) || !input.every(isIsoDate)) return null;
  return cleanBooked(input);
}

export function bookedSetsEqual(left, right) {
  const a = cleanBooked(left);
  const b = cleanBooked(right);
  return a.length === b.length && a.every((date, index) => date === b[index]);
}
