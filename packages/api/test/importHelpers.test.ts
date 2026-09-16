import { normalizeMobile } from '../src/utils/importLeads';
import { isHeaderEcho } from '../src/utils/leadColumns';

/** Small pure helpers whose mistakes are silent and expensive. */
describe('normalizeMobile', () => {
  test('bare national number becomes Indian E.164', () => {
    expect(normalizeMobile('9876543210')).toBe('+919876543210');
    expect(normalizeMobile('98765 43210')).toBe('+919876543210');
    expect(normalizeMobile('09876543210')).toBe('+919876543210');
  });
  test('already-E.164 input is cleaned, not re-prefixed', () => {
    expect(normalizeMobile('+91 98765-43210')).toBe('+919876543210');
    expect(normalizeMobile('919876543210')).toBe('+919876543210');
  });
  test('unknown shapes are preserved rather than guessed', () => {
    // Mangling a US number into +91... would create a wrong contact that dedups badly.
    expect(normalizeMobile('+1 415 555 0134')).toBe('+14155550134');
    expect(normalizeMobile('555-1234')).toBe('555-1234');
    expect(normalizeMobile(null)).toBeNull();
  });
});

describe('isHeaderEcho', () => {
  test('a row of column names is rejected', () => {
    expect(isHeaderEcho({ company_name: 'company_name', job_title: 'job_title' })).toBe(true);
  });
  test('one coincidental value is not', () => {
    expect(isHeaderEcho({ company_name: 'Acme', job_title: 'role' })).toBe(false);
  });
  test('a real row that happens to use key words elsewhere still imports', () => {
    expect(isHeaderEcho({
      company_name: 'Notes Ltd', notes: 'notes', hr_email: 'hr@notes.example',
    })).toBe(false);   // three fields, only two echo -> not the whole row
  });
});
