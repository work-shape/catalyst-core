// What an employee earns and what a month's payroll run owes. Wages come in bands, an employee
// keeps one band, and a month's totals follow from the head count without reading each payslip.

/** The gross monthly wages of the sample, in euros, before a client's wage level. */
const GROSS_WAGES = [2_250, 2_600, 2_900, 3_200, 3_500, 3_900, 4_400, 5_200];
/** The share of each band's gross wage withheld as wage tax. */
const WAGE_TAX_RATES = [0.08, 0.1, 0.12, 0.14, 0.15, 0.17, 0.19, 0.22];
const EMPLOYEE_SOCIAL_SECURITY_RATE = 0.205;
const EMPLOYER_SOCIAL_SECURITY_RATE = 0.21;

/** What one usual employee costs a month, in euros: the gross wage and the employer's share. */
export function employeeCostEuros(wageLevel: number): number {
  const meanGross = GROSS_WAGES.reduce((sum, wage) => sum + wage, 0) / GROSS_WAGES.length;
  return meanGross * wageLevel * (1 + EMPLOYER_SOCIAL_SECURITY_RATE);
}

function payslipOfBand(wageLevel: number, band: number) {
  const grossCents = Math.round((GROSS_WAGES[band] ?? 0) * wageLevel * 100);
  const wageTaxCents = Math.round(grossCents * (WAGE_TAX_RATES[band] ?? 0));
  const employeeShareCents = Math.round(grossCents * EMPLOYEE_SOCIAL_SECURITY_RATE);
  return {
    netCents: grossCents - wageTaxCents - employeeShareCents,
    wageTaxCents,
    employeeShareCents,
    employerShareCents: Math.round(grossCents * EMPLOYER_SOCIAL_SECURITY_RATE)
  };
}

/** The payslip of the employee with the number `employee`, counted from 0. */
export function payslip(wageLevel: number, employee: number) {
  return payslipOfBand(wageLevel, employee % GROSS_WAGES.length);
}

/** What the payslips of `employees` employees owe the tax office and the health insurers together. */
export function payrollTotals(wageLevel: number, employees: number) {
  let wageTaxCents = 0;
  let socialSecurityCents = 0;
  for (let band = 0; band < GROSS_WAGES.length; band += 1) {
    const heads = Math.ceil((employees - band) / GROSS_WAGES.length);
    if (heads <= 0) break;
    const slip = payslipOfBand(wageLevel, band);
    wageTaxCents += heads * slip.wageTaxCents;
    socialSecurityCents += heads * (slip.employeeShareCents + slip.employerShareCents);
  }
  return { wageTaxCents, socialSecurityCents };
}

/** A payslip is booked in five lines: the net wage, the wage tax, both shares of social security and the transfer of the net wage. */
export const BOOKINGS_PER_PAYSLIP = 5;

/** How many bookings a month's payroll run has: the payslips, and one payment each to the tax office and the health insurers. */
export function payrollBookingCount(employees: number): number {
  return employees === 0 ? 0 : employees * BOOKINGS_PER_PAYSLIP + 2;
}
