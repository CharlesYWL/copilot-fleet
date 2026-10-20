const decimalFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const compactUnits = [
  { suffix: "B", divisor: 1e9 },
  { suffix: "M", divisor: 1e6 },
  { suffix: "K", divisor: 1e3 },
] as const;

/** Decimal units, promoting values that round to the next unit (999.999K → 1.00M). */
export const formatUsageAmount = (value: number | null): string => {
  if (value === null) return "—";
  if (value < 1_000) return decimalFormat.format(value);
  let unitIndex = compactUnits.findIndex(({ divisor }) => value >= divisor);
  let unit = compactUnits[unitIndex]!;
  if (Number((value / unit.divisor).toFixed(2)) >= 1_000 && unitIndex > 0) {
    unitIndex--;
    unit = compactUnits[unitIndex]!;
  }
  return `${(value / unit.divisor).toFixed(2)}${unit.suffix}`;
};

export const exactUsageAmount = (value: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 9 }).format(value);
