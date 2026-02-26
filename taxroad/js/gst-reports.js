/**
 * gst-reports.js — GST Report Generation Engine
 * Generates GSTR-3B and GSTR-2A (ITC) Excel reports from billing data.
 *
 * Architecture:
 *  - All computation is client-side (on-demand, not at page load)
 *  - Tax split (CGST/SGST vs IGST) is derived from GSTIN state codes
 *  - Excel export uses SheetJS (XLSX) loaded via CDN
 */

import {
    auth, db, onAuthStateChanged, collection, query, getDocs,
    doc, getDoc, signOut, where, orderBy
} from './firebase-config.js';
import { loadComponents, showToast, formatCurrency, setPageTitle } from './utils.js';

// ─────────────────────────────────────────────
// Indian State Code → Name Map (GSTIN prefix)
// ─────────────────────────────────────────────
const STATE_CODES = {
    '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
    '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
    '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
    '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
    '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
    '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam',
    '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
    '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
    '26': 'Dadra & NH / Daman & Diu', '27': 'Maharashtra',
    '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
    '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
    '35': 'Andaman & Nicobar', '36': 'Telangana', '37': 'Andhra Pradesh'
};

// GST-compliant financial month mapping:
// Financial Year runs April–March.
// UI months: 1=April … 12=March
const FY_MONTH_MAP = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const FY_MONTH_NAMES = [
    'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December', 'January', 'February', 'March'
];

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
let currentUser = null;
let userData = {};          // user profile (businessName, gstIn, etc.)
let reportData = null;      // last generated report payload

// ─────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────
async function initGSTReports() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) { window.location.href = 'index.html'; return; }
        currentUser = user;

        await loadComponents();
        setupNavigation();
        populatePeriodSelectors();
        setupEventListeners();
        await loadUserProfile();
    });
}

function setupNavigation() {
    setPageTitle('GST Reports');
    const sidebar = document.getElementById('sidebar-container');
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const overlay = document.getElementById('mobile-overlay');

    if (hamburgerBtn && sidebar && overlay) {
        hamburgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('active');
        });
        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        });
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            try { await signOut(auth); } catch { showToast('Logout error', 'error'); }
        });
    }
}

function populatePeriodSelectors() {
    // Pre-select current financial month
    const now = new Date();
    const calMonth = now.getMonth() + 1; // 1-12
    const calYear = now.getFullYear();

    // Map calendar month to FY month index (1–12)
    const fyMonthIdx = FY_MONTH_MAP.indexOf(calMonth) + 1; // 1–12

    const monthSel = document.getElementById('select-month');
    if (monthSel && fyMonthIdx > 0) monthSel.value = String(fyMonthIdx);

    // Populate Financial Year dropdown (last 5 FYs)
    const fySel = document.getElementById('select-fy');
    // Current FY start year: if month >= April, FY = calYear–(calYear+1)
    const currentFYStart = calMonth >= 4 ? calYear : calYear - 1;

    for (let i = 0; i < 5; i++) {
        const fyStart = currentFYStart - i;
        const option = document.createElement('option');
        option.value = String(fyStart);
        option.textContent = `${fyStart}–${(fyStart + 1).toString().slice(2)}`;
        fySel.appendChild(option);
    }
}

function setupEventListeners() {
    document.getElementById('btn-generate').addEventListener('click', generateReport);
    document.getElementById('btn-download-gstr3b').addEventListener('click', downloadGSTR3B);
    document.getElementById('btn-download-gstr2a').addEventListener('click', downloadGSTR2A);
    document.getElementById('btn-print').addEventListener('click', () => window.print());
}

async function loadUserProfile() {
    try {
        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        if (userDoc.exists()) {
            userData = userDoc.data();
            const nameDisplay = document.getElementById('user-display-name');
            if (nameDisplay && userData.businessName) {
                nameDisplay.textContent = userData.businessName;
                nameDisplay.style.display = 'block';
            }
        }
        updateComplianceBadge([]);
    } catch (e) {
        console.error('[GST] Error loading user profile:', e);
    }
}

// ─────────────────────────────────────────────
// GSTIN Utilities
// ─────────────────────────────────────────────
function getStateCode(gstin) {
    if (!gstin || gstin.length < 2) return null;
    return gstin.trim().substring(0, 2).toUpperCase();
}

/**
 * Determine supply type from GSTIN state codes.
 * Returns 'intra' (CGST+SGST) or 'inter' (IGST).
 * Defaults to 'intra' when GST numbers are unavailable.
 */
function getSupplyType(bizGstin, custGstin) {
    const bizState = getStateCode(bizGstin);
    const custState = getStateCode(custGstin);
    if (!bizState || !custState) return 'intra'; // conservative default
    return bizState === custState ? 'intra' : 'inter';
}

/**
 * Compute CGST/SGST from gstAmount: always split 50/50.
 * Prefers stored cgstAmount/sgstAmount if present on the invoice.
 */
function computeTaxSplit(inv) {
    // Use pre-stored values if available (new invoices)
    if (inv.cgstAmount !== undefined && inv.sgstAmount !== undefined) {
        return {
            cgst: Number(inv.cgstAmount) || 0,
            sgst: Number(inv.sgstAmount) || 0,
            igst: 0  // we don't use IGST at invoice level
        };
    }
    // Legacy invoices: derive from gstAmount
    const amt = Number(inv.gstAmount) || 0;
    return { cgst: +(amt / 2).toFixed(2), sgst: +(amt / 2).toFixed(2), igst: 0 };
}

/**
 * Return calendar month (1-12) and calendar year from FY month index and FY start year.
 */
function fyToCalendar(fyMonthIdx, fyStartYear) {
    const calMonth = FY_MONTH_MAP[fyMonthIdx - 1]; // 1-indexed
    // Months Jan–Mar belong to the next calendar year in Indian FY
    const calYear = calMonth >= 4 ? fyStartYear : fyStartYear + 1;
    return { calMonth, calYear };
}

// ─────────────────────────────────────────────
// Report Generation
// ─────────────────────────────────────────────
async function generateReport() {
    const fyMonthIdx = parseInt(document.getElementById('select-month').value, 10);
    const fyStartYear = parseInt(document.getElementById('select-fy').value, 10);

    const { calMonth, calYear } = fyToCalendar(fyMonthIdx, fyStartYear);

    console.log(`[GST] Generating for FY month=${FY_MONTH_NAMES[fyMonthIdx - 1]} ${fyStartYear}–${fyStartYear + 1}`);
    console.log(`[GST] → Calendar: ${calMonth}/${calYear}`);

    const btn = document.getElementById('btn-generate');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    // Show/hide sections
    document.getElementById('empty-section').classList.add('hidden');
    document.getElementById('summary-section').classList.add('hidden');
    document.getElementById('warnings-section').classList.add('hidden');

    try {
        // ── 1. Fetch all invoices for the period ──────────────────────
        const allInvoices = await fetchInvoicesForPeriod(calMonth, calYear);
        console.log(`[GST] Invoices found: ${allInvoices.length}`);

        // ── 2. Fetch customers for GSTIN lookup ───────────────────────
        const customersMap = await fetchCustomersMap();

        // ── 3. Build GSTR-3B summary ──────────────────────────────────
        const summary = buildGSTR3BSummary(allInvoices, customersMap);

        // ── 4. Compliance warnings ────────────────────────────────────
        const warnings = buildComplianceWarnings(allInvoices, customersMap);

        // ── 5. Store for download ─────────────────────────────────────
        reportData = {
            summary,
            invoices: allInvoices,
            customersMap,
            warnings,
            fyMonthIdx,
            fyStartYear,
            periodLabel: `${FY_MONTH_NAMES[fyMonthIdx - 1]} ${fyStartYear}–${fyStartYear + 1}`,
        };

        // ── 6. Render UI ───────────────────────────────────────────────
        renderSummaryTable(summary, reportData.periodLabel);
        renderWarnings(warnings);
        updateComplianceBadge(warnings);

        document.getElementById('summary-section').classList.remove('hidden');
        if (warnings.length > 0) document.getElementById('warnings-section').classList.remove('hidden');

    } catch (err) {
        console.error('[GST] Error generating report:', err);
        showToast('Error generating report: ' + (err.message || err), 'error');
        document.getElementById('empty-section').classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z"/></svg> Generate Report`;
    }
}

async function fetchInvoicesForPeriod(calMonth, calYear) {
    // Build date range: first day ... last day of the calendar month
    const startDate = new Date(calYear, calMonth - 1, 1).toISOString();
    const endDate = new Date(calYear, calMonth, 0, 23, 59, 59).toISOString();

    console.log(`[GST] Date range: ${startDate} → ${endDate}`);

    const invRef = collection(db, `users/${currentUser.uid}/invoices`);
    // createdAt is stored as ISO string, so string comparison works
    const q = query(invRef,
        where('createdAt', '>=', startDate),
        where('createdAt', '<=', endDate),
        orderBy('createdAt', 'asc')
    );
    const snaps = await getDocs(q);
    const results = [];
    snaps.forEach(s => results.push({ id: s.id, ...s.data() }));
    return results;
}

async function fetchCustomersMap() {
    const custRef = collection(db, `users/${currentUser.uid}/customers`);
    const snaps = await getDocs(custRef);
    const map = {};
    snaps.forEach(s => { map[s.id] = s.data(); });
    return map;
}

// ─────────────────────────────────────────────
// GSTR-3B Aggregation Logic
// ─────────────────────────────────────────────
function buildGSTR3BSummary(invoices, customersMap) {
    const bizGstin = (userData.gstNumber || '').trim();

    // Accumulators by supply type
    const intra = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, count: 0 };
    const inter = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, count: 0 };
    const exempt = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, count: 0 };

    const rows = []; // invoice-level detail for sheet 2

    invoices.forEach(inv => {
        const taxableVal = +(Number(inv.subtotal) || 0).toFixed(2);
        const gstAmt = +(Number(inv.gstAmount) || 0).toFixed(2);

        const split = computeTaxSplit(inv);

        // All amounts go to CGST+SGST (intra-state split applied at invoice level)
        if (gstAmt === 0) {
            exempt.taxableValue += taxableVal;
            exempt.count++;
        } else {
            intra.taxableValue += taxableVal;
            intra.cgst += split.cgst;
            intra.sgst += split.sgst;
            intra.count++;
        }

        const customer = customersMap[inv.customerId] || {};
        rows.push({
            invoiceNumber: inv.invoiceNumber || '',
            customerName: customer.partyName || 'Unknown',
            customerGstin: (customer.gstNumber || 'N/A'),
            date: inv.createdAt ? inv.createdAt.substring(0, 10) : '',
            status: inv.status || 'Pending',
            supplyType: 'CGST+SGST',
            taxableValue: taxableVal,
            cgst: split.cgst,
            sgst: split.sgst,
            igst: 0,
            totalGst: gstAmt,
            grossTotal: +(Number(inv.total) || 0).toFixed(2),
            hsnSummary: buildHSNSummary(inv.items || []),
        });
    });

    // Round all accumulators
    const r = v => +v.toFixed(2);
    intra.taxableValue = r(intra.taxableValue);
    intra.cgst = r(intra.cgst);
    intra.sgst = r(intra.sgst);
    inter.taxableValue = r(inter.taxableValue);
    inter.igst = r(inter.igst);
    exempt.taxableValue = r(exempt.taxableValue);

    const totals = {
        taxableValue: r(intra.taxableValue + inter.taxableValue + exempt.taxableValue),
        cgst: intra.cgst,
        sgst: intra.sgst,
        igst: inter.igst,
        totalTax: r(intra.cgst + intra.sgst + inter.igst),
    };

    return { intra, inter, exempt, totals, rows };
}

function buildHSNSummary(items) {
    return items
        .filter(i => i.hsnCode)
        .map(i => i.hsnCode)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(', ') || 'N/A';
}

// ─────────────────────────────────────────────
// Compliance Warnings
// ─────────────────────────────────────────────
function buildComplianceWarnings(invoices, customersMap) {
    const warnings = [];
    const bizGstin = (userData.gstNumber || '').trim();

    if (!bizGstin) {
        warnings.push({ type: 'error', msg: 'Business GSTIN not configured. Go to Settings → Business Profile to add it.' });
    }

    let missingCustGstin = 0;
    let missingHsn = 0;

    invoices.forEach(inv => {
        const cust = customersMap[inv.customerId] || {};
        if (!cust.gstNumber) missingCustGstin++;
        const hasHsn = (inv.items || []).some(it => it.hsnCode && it.hsnCode.trim());
        if (!hasHsn) missingHsn++;
    });

    if (missingCustGstin > 0) {
        warnings.push({ type: 'warn', msg: `${missingCustGstin} invoice(s) linked to customers without a GSTIN. These are treated as intra-state B2C supplies.` });
    }

    if (missingHsn > 0) {
        warnings.push({ type: 'warn', msg: `${missingHsn} invoice(s) have items without HSN/SAC codes. These are required for GSTR-1 HSN summary.` });
    }

    if (invoices.length === 0) {
        warnings.push({ type: 'warn', msg: 'No invoices found for this period. Verify the selected month and year.' });
    }

    if (warnings.length === 0 && invoices.length > 0) {
        warnings.push({ type: 'ok', msg: `All ${invoices.length} invoice(s) have complete GST data. Ready to file.` });
    }

    return warnings;
}

// ─────────────────────────────────────────────
// UI Rendering
// ─────────────────────────────────────────────
function r2(n) { return n.toFixed(2); }

function renderSummaryTable(summary, periodLabel) {
    document.getElementById('report-period-title').textContent = `Period: ${periodLabel}`;

    const tbody = document.getElementById('gstr3b-tbody');
    const tfoot = document.getElementById('gstr3b-tfoot');

    tbody.innerHTML = `
        <tr>
            <td style="padding:10px 12px;">Outward Taxable Supplies — Intra-state (CGST + SGST)</td>
            <td style="text-align:right;padding:10px 12px;">${r2(summary.intra.taxableValue)}</td>
            <td style="text-align:right;padding:10px 12px;">—</td>
            <td style="text-align:right;padding:10px 12px;">${r2(summary.intra.cgst)}</td>
            <td style="text-align:right;padding:10px 12px;">${r2(summary.intra.sgst)}</td>
            <td style="text-align:right;padding:10px 12px;">0.00</td>
        </tr>
        <tr>
            <td style="padding:10px 12px;">Outward Taxable Supplies — Inter-state (IGST)</td>
            <td style="text-align:right;padding:10px 12px;">${r2(summary.inter.taxableValue)}</td>
            <td style="text-align:right;padding:10px 12px;">${r2(summary.inter.igst)}</td>
            <td style="text-align:right;padding:10px 12px;">—</td>
            <td style="text-align:right;padding:10px 12px;">—</td>
            <td style="text-align:right;padding:10px 12px;">0.00</td>
        </tr>
        <tr>
            <td style="padding:10px 12px; color:var(--text-muted);">Zero-rated / Nil-rated / Exempt</td>
            <td style="text-align:right;padding:10px 12px;">${r2(summary.exempt.taxableValue)}</td>
            <td style="text-align:right;padding:10px 12px;">0.00</td>
            <td style="text-align:right;padding:10px 12px;">0.00</td>
            <td style="text-align:right;padding:10px 12px;">0.00</td>
            <td style="text-align:right;padding:10px 12px;">0.00</td>
        </tr>
    `;

    tfoot.innerHTML = `
        <tr>
            <td style="padding:10px 12px; font-weight:700;">TOTAL</td>
            <td style="text-align:right;padding:10px 12px; font-weight:700;">${r2(summary.totals.taxableValue)}</td>
            <td style="text-align:right;padding:10px 12px; font-weight:700;">${r2(summary.totals.igst)}</td>
            <td style="text-align:right;padding:10px 12px; font-weight:700;">${r2(summary.totals.cgst)}</td>
            <td style="text-align:right;padding:10px 12px; font-weight:700;">${r2(summary.totals.sgst)}</td>
            <td style="text-align:right;padding:10px 12px; font-weight:700;">0.00</td>
        </tr>
    `;

    // Update stat cards
    document.getElementById('stat-taxable').textContent = formatCurrency(summary.totals.taxableValue);
    document.getElementById('stat-igst').textContent = formatCurrency(summary.totals.igst);
    document.getElementById('stat-cgst').textContent = formatCurrency(summary.totals.cgst);
    document.getElementById('stat-sgst').textContent = formatCurrency(summary.totals.cgst); // SGST === CGST
    document.getElementById('stat-total-tax').textContent = formatCurrency(summary.totals.totalTax);
}

function renderWarnings(warnings) {
    const list = document.getElementById('warnings-list');
    list.innerHTML = warnings.map(w => `
        <li class="warning-item ${w.type}">
            <span>${w.type === 'ok' ? '✅' : w.type === 'error' ? '❌' : '⚠️'}</span>
            <span>${w.msg}</span>
        </li>
    `).join('');
}

function updateComplianceBadge(warnings) {
    const badge = document.getElementById('compliance-status-badge');
    const bizGstin = (userData.gstNumber || '').trim();

    if (!bizGstin) {
        badge.className = 'compliance-status status-missing';
        badge.textContent = '❌ Business GSTIN not configured';
        return;
    }

    const hasError = warnings.some(w => w.type === 'error');
    const hasWarn = warnings.some(w => w.type === 'warn');

    if (hasError) {
        badge.className = 'compliance-status status-missing';
        badge.textContent = '❌ Missing Critical Data';
    } else if (hasWarn) {
        badge.className = 'compliance-status status-review';
        badge.textContent = '⚠ Review Required Before Filing';
    } else if (warnings.some(w => w.type === 'ok')) {
        badge.className = 'compliance-status status-ready';
        badge.textContent = '✅ Ready to File';
    } else {
        badge.className = 'compliance-status status-review';
        badge.textContent = `GSTIN: ${bizGstin}`;
    }
}

// ─────────────────────────────────────────────
// Excel Export — GSTR-3B
// ─────────────────────────────────────────────
function downloadGSTR3B() {
    if (!reportData) { showToast('Please generate the report first.', 'error'); return; }
    if (typeof XLSX === 'undefined') { showToast('Excel library not loaded. Check internet connection.', 'error'); return; }

    const { summary, invoices, periodLabel, fyStartYear, fyMonthIdx } = reportData;
    const bizName = (userData.businessName || 'Business').replace(/[^a-zA-Z0-9 ]/g, '');
    const bizGstin = userData.gstNumber || 'N/A';
    const stateName = STATE_CODES[getStateCode(bizGstin)] || 'Unknown State';

    const wb = XLSX.utils.book_new();

    // ── Sheet 1: GSTR-3B Summary ──────────────────────────────────────
    const s1Data = [
        [`GSTR-3B RETURN SUMMARY`],
        [`Business Name: ${bizName}`],
        [`GSTIN: ${bizGstin}`],
        [`State: ${stateName}`],
        [`Period: ${periodLabel}`],
        [`Generated On: ${new Date().toLocaleString('en-IN')}`],
        [],
        ['Section 3.1 – Details of Outward Supplies and Intra/Inter-state Supplies'],
        [],
        ['Nature of Supplies', 'Taxable Value (₹)', 'IGST (₹)', 'CGST (₹)', 'SGST/UTGST (₹)', 'Cess (₹)'],
        [
            'Outward Taxable (Intra-state)',
            summary.intra.taxableValue, 0,
            summary.intra.cgst, summary.intra.sgst, 0
        ],
        [
            'Outward Taxable (Inter-state)',
            summary.inter.taxableValue,
            summary.inter.igst, 0, 0, 0
        ],
        [
            'Zero/Nil/Exempt Supplies',
            summary.exempt.taxableValue, 0, 0, 0, 0
        ],
        [
            'TOTAL',
            summary.totals.taxableValue,
            summary.totals.igst,
            summary.totals.cgst,
            summary.totals.sgst,  // SGST
            0
        ],
        [],
        ['Section 6 – Payment of Tax'],
        [],
        ['Tax Head', 'Total Liability (₹)', 'ITC Available (₹)', 'Net Payable (₹)'],
        ['IGST', summary.totals.igst, 0, summary.totals.igst],
        ['CGST', summary.totals.cgst, 0, summary.totals.cgst],
        ['SGST/UTGST', summary.totals.sgst, 0, summary.totals.sgst],
        ['CESS', 0, 0, 0],
        ['TOTAL TAX PAYABLE', summary.totals.totalTax, 0, summary.totals.totalTax],
        [],
        ['⚠ This is a system-generated summary. Verify with your CA before filing on gstin.gov.in'],
    ];

    const ws1 = XLSX.utils.aoa_to_sheet(s1Data);
    ws1['!cols'] = [{ wch: 42 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws1, '3B Summary');

    // ── Sheet 2: Invoice-wise Tax Liability ───────────────────────────
    const s2Header = [
        'Invoice #', 'Date', 'Customer Name', 'Customer GSTIN',
        'Supply Type', 'Status', 'Taxable Value (₹)',
        'IGST (₹)', 'CGST (₹)', 'SGST (₹)', 'Total GST (₹)',
        'Gross Total (₹)', 'HSN/SAC Codes'
    ];

    const s2Rows = summary.rows.map(r => [
        r.invoiceNumber, r.date, r.customerName, r.customerGstin,
        r.supplyType === 'intra' ? 'Intra-state' : 'Inter-state',
        r.status, r.taxableValue,
        r.igst, r.cgst, r.sgst, r.totalGst,
        r.grossTotal, r.hsnSummary
    ]);

    const s2Data = [s2Header, ...s2Rows];
    const ws2 = XLSX.utils.aoa_to_sheet(s2Data);
    ws2['!cols'] = [
        { wch: 14 }, { wch: 12 }, { wch: 28 }, { wch: 18 },
        { wch: 14 }, { wch: 14 }, { wch: 18 },
        { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
        { wch: 16 }, { wch: 16 }
    ];
    XLSX.utils.book_append_sheet(wb, ws2, 'Tax Liability');

    // ── Sheet 3: Outward Supplies (Customer-wise) ─────────────────────
    const custAgg = {};
    summary.rows.forEach(r => {
        if (!custAgg[r.customerGstin]) {
            custAgg[r.customerGstin] = {
                name: r.customerName, gstin: r.customerGstin,
                taxableValue: 0, igst: 0, cgst: 0, sgst: 0, totalGst: 0, invoiceCount: 0
            };
        }
        const ca = custAgg[r.customerGstin];
        ca.taxableValue += r.taxableValue;
        ca.igst += r.igst;
        ca.cgst += r.cgst;
        ca.sgst += r.sgst;
        ca.totalGst += r.totalGst;
        ca.invoiceCount++;
    });

    const s3Header = ['Customer Name', 'Customer GSTIN', 'Invoice Count', 'Taxable Value (₹)', 'IGST (₹)', 'CGST (₹)', 'SGST (₹)', 'Total GST (₹)'];
    const s3Rows = Object.values(custAgg).map(ca => [
        ca.name, ca.gstin, ca.invoiceCount,
        +ca.taxableValue.toFixed(2), +ca.igst.toFixed(2),
        +ca.cgst.toFixed(2), +ca.sgst.toFixed(2), +ca.totalGst.toFixed(2)
    ]);
    const ws3 = XLSX.utils.aoa_to_sheet([s3Header, ...s3Rows]);
    ws3['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Outward Supplies');

    // ── Sheet 4: Disclaimer ───────────────────────────────────────────
    const ws4 = XLSX.utils.aoa_to_sheet([
        ['COMPLIANCE DISCLAIMER'],
        [],
        ['This report has been auto-generated by Tax Road from your billing data.'],
        ['It is provided for reference purposes only and is NOT a substitute for professional tax advice.'],
        [],
        ['Before Filing:'],
        ['1. Verify all figures with your Chartered Accountant (CA) or Tax Professional.'],
        ['2. Cross-check with your GSTR-1 (outward supplies) already filed.'],
        ['3. Validate Input Tax Credit (ITC) eligibility.'],
        ['4. Log in to the GST Portal (gstin.gov.in) to file your actual GSTR-3B.'],
        [],
        ['Tax Road is not responsible for any incorrect filings based on this report.'],
        [],
        [`Generated: ${new Date().toLocaleString('en-IN')}`],
        [`Software: Tax Road — Smart Billing for Indian Businesses`],
    ]);
    ws4['!cols'] = [{ wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ws4, 'Disclaimer');

    // ── Download ──────────────────────────────────────────────────────
    const fyLabel = `${FY_MONTH_NAMES[fyMonthIdx - 1]}_${fyStartYear}`;
    const filename = `${bizName.replace(/\s+/g, '_')}_GSTR3B_${fyLabel}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast('GSTR-3B Excel downloaded!', 'success');
}

// ─────────────────────────────────────────────
// Excel Export — GSTR-2A ITC Template
// ─────────────────────────────────────────────
function downloadGSTR2A() {
    if (!reportData) { showToast('Please generate the report first.', 'error'); return; }
    if (typeof XLSX === 'undefined') { showToast('Excel library not loaded.', 'error'); return; }

    const { fyMonthIdx, fyStartYear } = reportData;
    const bizName = (userData.businessName || 'Business').replace(/[^a-zA-Z0-9 ]/g, '');
    const bizGstin = userData.gstNumber || 'N/A';

    const wb = XLSX.utils.book_new();

    // ── Sheet 1: ITC Summary ──────────────────────────────────────────
    const ws1 = XLSX.utils.aoa_to_sheet([
        ['GSTR-2A / ITC SUMMARY TEMPLATE'],
        [`Business: ${bizName}  |  GSTIN: ${bizGstin}  |  Period: ${reportData.periodLabel}`],
        [],
        ['ℹ NOTE: GSTR-2A is auto-drafted by the GST portal from your suppliers\' GSTR-1 filings.'],
        ['This template helps you track and reconcile ITC claims from your purchase data.'],
        [],
        ['ITC ELIGIBLE — OVERVIEW'],
        [],
        ['ITC Head', 'ITC Available (₹)', 'ITC Claimed (₹)', 'ITC Balance (₹)', 'Notes'],
        ['IGST', 0, 0, 0, 'Enter from purchase invoices'],
        ['CGST', 0, 0, 0, 'Enter from purchase invoices'],
        ['SGST/UTGST', 0, 0, 0, 'Enter from purchase invoices'],
        ['CESS', 0, 0, 0, ''],
        ['TOTAL ITC', 0, 0, 0, 'Net of all heads'],
        [],
        ['⚠ A "Purchases" module is required to auto-populate ITC figures. Contact your CA for manual entries.'],
    ]);
    ws1['!cols'] = [{ wch: 20 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'ITC Summary');

    // ── Sheet 2: Purchase Register Template ───────────────────────────
    const ws2 = XLSX.utils.aoa_to_sheet([
        ['PURCHASE REGISTER — DATA ENTRY TEMPLATE'],
        ['Fill this sheet with your purchase invoices to enable ITC reconciliation.'],
        [],
        [
            'Invoice Date', 'Supplier Name', 'Supplier GSTIN', 'Invoice Number',
            'Taxable Value (₹)', 'IGST (₹)', 'CGST (₹)', 'SGST/UTGST (₹)',
            'Total Amount (₹)', 'ITC Eligible (Y/N)', 'HSN/SAC', 'Notes'
        ],
        // Blank rows for user data entry
        ...Array(20).fill(['', '', '', '', '', '', '', '', '', 'Y', '', '']),
    ]);
    ws2['!cols'] = [
        { wch: 13 }, { wch: 28 }, { wch: 18 }, { wch: 16 },
        { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
        { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 20 }
    ];
    XLSX.utils.book_append_sheet(wb, ws2, 'Purchase Register');

    // ── Sheet 3: ITC Reconciliation Framework ────────────────────────
    const ws3 = XLSX.utils.aoa_to_sheet([
        ['ITC RECONCILIATION FRAMEWORK'],
        [],
        ['Step', 'Action', 'Source', 'Status'],
        ['1', 'Download GSTR-2A from GST portal', 'gstin.gov.in → Returns → GSTR-2B', '☐ Pending'],
        ['2', 'Fill Purchase Register in this file', 'Your purchase invoices', '☐ Pending'],
        ['3', 'Match GSTR-2A entries with Purchase Register', 'Both above', '☐ Pending'],
        ['4', 'Identify mismatches (supplier not filed GSTR-1)', 'Comparison result', '☐ Pending'],
        ['5', 'Claim only matched ITC in GSTR-3B Table 4', 'After reconciliation', '☐ Pending'],
        [],
        ['RECONCILIATION RULES (Per GST Law)'],
        [],
        ['Rule', 'Description'],
        ['Sec 16(2)(a)', 'Tax invoice / Debit Note must exist in buyer\'s records'],
        ['Sec 16(2)(b)', 'Supplier must have filed GSTR-1 (visible in GSTR-2A/2B)'],
        ['Sec 16(2)(c)', 'Tax must have been paid to Government by supplier'],
        ['Sec 16(2)(d)', 'Goods/services received'],
        ['Rule 36(4)', 'Provisional ITC limited to 5% of eligible credit (currently 0% — only 2B ITC allowed)'],
        [],
        ['⚠ Consult your CA before claiming ITC.'],
    ]);
    ws3['!cols'] = [{ wch: 8 }, { wch: 55 }, { wch: 40 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Reconciliation Guide');

    const fyLabel = `${FY_MONTH_NAMES[fyMonthIdx - 1]}_${fyStartYear}`;
    const filename = `${bizName.replace(/\s+/g, '_')}_GSTR2A_ITC_${fyLabel}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast('GSTR-2A ITC Template downloaded!', 'success');
}

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
initGSTReports();
