import { auth, db, onAuthStateChanged, collection, query, getDocs, addDoc, updateDoc, doc, getDoc, serverTimestamp, signOut } from './firebase-config.js';
import { loadComponents, showToast, formatCurrency, formatDate, setPageTitle } from './utils.js';

let currentUser = null;
let allReceiptsRaw = [];
let pendingInvoices = []; // For dropdown
let invoiceMap = {}; // id -> invoice data
let customerMap = {}; // id -> name

// DOM
const tbody = document.getElementById('receipts-body');
const modal = document.getElementById('receipt-modal');
const form = document.getElementById('receipt-form');
const btnAdd = document.getElementById('btn-add-receipt');
const btnClose = document.getElementById('modal-close');
const btnCancel = document.getElementById('btn-cancel');
const invoiceSelect = document.getElementById('receipt-invoice');
const amountInput = document.getElementById('receipt-amount');

// Init
async function initReceipts() {
    console.log('[TAX ROAD DEBUG] Receipts module loaded, checking auth state...');
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            console.log('[TAX ROAD DEBUG] No user logged in, redirecting to login...');
            window.location.href = 'index.html';
            return;
        }

        console.log(`[TAX ROAD DEBUG] User authenticated: ${user.uid}`);
        currentUser = user;

        console.log('[TAX ROAD DEBUG] Loading UI components...');
        await loadComponents();
        setupNavigation();
        
        console.log('[TAX ROAD DEBUG] Loading user profile...');
        await loadUserProfile();

        console.log('[TAX ROAD DEBUG] Setting up event listeners...');
        setupEventListeners();
        
        console.log('[TAX ROAD DEBUG] Loading customers and invoices reference data...');
        await loadCustomersAndInvoices();
        
        console.log('[TAX ROAD DEBUG] Fetching receipts...');
        await fetchReceipts();
    });
}

function setupNavigation() {
    console.log('[TAX ROAD DEBUG] === SETUP NAVIGATION START ===');
    
    // Debug: Check sidebar in DOM
    const sidebar = document.getElementById('sidebar-container');
    console.log('[TAX ROAD DEBUG] Sidebar container exists:', !!sidebar);
    if (sidebar) {
        console.log('[TAX ROAD DEBUG] Sidebar innerHTML length:', sidebar.innerHTML.length);
    }
    
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const overlay = document.getElementById('mobile-overlay');

    console.log('[TAX ROAD DEBUG] Hamburger btn found:', !!hamburgerBtn);
    console.log('[TAX ROAD DEBUG] Overlay found:', !!overlay);

    if (hamburgerBtn && sidebar && overlay) {
        hamburgerBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            overlay.classList.toggle('active');
        });
        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        });
    } else {
        console.warn('[TAX ROAD WARN] Hamburger navigation elements not found');
    }

    // Set Page Title
    setPageTitle('Receipts');

    // CRITICAL: Debug logout button
    console.log('[TAX ROAD DEBUG] === SEARCHING FOR LOGOUT BUTTON ===');
    const logoutBtn = document.getElementById('logout-btn');
    console.log('[TAX ROAD DEBUG] Logout button found:', !!logoutBtn);
    
    if (logoutBtn) {
        console.log('[TAX ROAD DEBUG] ✓ Logout button FOUND - Adding click listener');
        logoutBtn.addEventListener('click', async () => {
            try {
                console.log('[TAX ROAD DEBUG] Logging out user...');
                await signOut(auth);
                console.log('[TAX ROAD DEBUG] Logout successful');
            } catch (error) {
                console.error('[TAX ROAD ERROR] Logout Error:', error);
                showToast("Error during logout", "error");
            }
        });
    } else {
        console.error('[TAX ROAD ERROR] ✗ Logout button NOT found');
        console.error('[TAX ROAD DEBUG] Sidebar HTML search for "logout":', 
            sidebar?.innerHTML?.includes('logout') ? '✓ FOUND' : '✗ NOT FOUND');
    }

    const searchInputInst = document.getElementById('global-search');
    if (searchInputInst) {
        searchInputInst.addEventListener('input', (e) => {
            console.log(`[TAX ROAD DEBUG] Searching receipts for: ${e.target.value}`);
            filterReceipts(e.target.value);
        });
    } else {
        console.warn('[TAX ROAD WARN] Search input not found');
    }
    
    console.log('[TAX ROAD DEBUG] === SETUP NAVIGATION END ===\n');
}

async function loadUserProfile() {
    try {
        console.log('[TAX ROAD DEBUG] Fetching user profile from Firestore...');
        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        if (userDoc.exists()) {
            const userData = userDoc.data();
            console.log('[TAX ROAD DEBUG] User profile loaded:', userData.businessName);
            const nameDisplay = document.getElementById('user-display-name');
            if (nameDisplay && userData.businessName) {
                nameDisplay.textContent = userData.businessName;
                nameDisplay.style.display = 'block';
            }
        } else {
            console.warn('[TAX ROAD WARN] No user profile found in Firestore');
        }
    } catch (e) { 
        console.error('[TAX ROAD ERROR] Error loading user profile:', e); 
    }
}

async function loadCustomersAndInvoices() {
    try {
        console.log('[TAX ROAD DEBUG] Loading customers and invoices reference data...');
        // Load Customers for names
        const cQ = query(collection(db, `users/${currentUser.uid}/customers`));
        const cSnaps = await getDocs(cQ);
        customerMap = {};
        cSnaps.forEach(snap => { customerMap[snap.id] = snap.data().partyName; });
        console.log(`[TAX ROAD DEBUG] Loaded ${cSnaps.size} customers for reference`);

        // Load Invoices
        const iQ = query(collection(db, `users/${currentUser.uid}/invoices`));
        const iSnaps = await getDocs(iQ);

        invoiceMap = {};
        pendingInvoices = [];

        iSnaps.forEach(snap => {
            const data = snap.data();
            invoiceMap[snap.id] = data;

            // Allow receiving payment if not fully Paid
            if (data.status !== 'Paid') {
                pendingInvoices.push({ id: snap.id, ...data });
            }
        });

        console.log(`[TAX ROAD DEBUG] Loaded ${iSnaps.size} invoices, ${pendingInvoices.length} pending payment`);

    } catch (e) {
        console.error("[TAX ROAD ERROR] Error loading reference data", e);
    }
}

function setupEventListeners() {
    btnAdd.addEventListener('click', openModal);
    btnClose.addEventListener('click', closeModal);
    btnCancel.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    form.addEventListener('submit', handleSaveReceipt);

    // Auto-fill max amount when invoice selected
    invoiceSelect.addEventListener('change', async (e) => {
        const invId = e.target.value;
        const infoBox = document.getElementById('invoice-balance-info');

        if (!invId) {
            infoBox.classList.add('hidden');
            amountInput.max = "";
            amountInput.value = "";
            return;
        }

        const invoice = invoiceMap[invId];
        if (!invoice) return;

        // Calculate paid amount so far
        let paidAmount = 0;
        try {
            const rQ = query(collection(db, `users/${currentUser.uid}/receipts`));
            const rSnaps = await getDocs(rQ);
            rSnaps.forEach(snap => {
                const rData = snap.data();
                if (rData.invoiceId === invId) {
                    paidAmount += Number(rData.amountReceived) || 0;
                }
            });
        } catch (err) { console.error(err); }

        const balance = (Number(invoice.total) || 0) - paidAmount;

        document.getElementById('info-total').textContent = formatCurrency(invoice.total);
        document.getElementById('info-balance').textContent = formatCurrency(balance);
        infoBox.classList.remove('hidden');

        amountInput.max = balance;
        amountInput.value = balance; // Prefill with balance
    });
}

function openModal() {
    form.reset();
    document.getElementById('invoice-balance-info').classList.add('hidden');
    document.getElementById('receipt-date').value = new Date().toISOString().split('T')[0];

    // Populate select
    invoiceSelect.innerHTML = '<option value="">Choose an invoice...</option>';

    // Sort logic
    pendingInvoices.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    pendingInvoices.forEach(inv => {
        const cName = customerMap[inv.customerId] || 'Unknown';
        const option = document.createElement('option');
        option.value = inv.id;
        option.textContent = `${inv.invoiceNumber} - ${cName} (${formatCurrency(inv.total)})`;
        invoiceSelect.appendChild(option);
    });

    modal.classList.add('active');
}

function closeModal() {
    modal.classList.remove('active');
    form.reset();
}

async function fetchReceipts() {
    try {
        console.log('[TAX ROAD DEBUG] Fetching receipts from Firestore...');
        const q = query(collection(db, `users/${currentUser.uid}/receipts`));
        const snaps = await getDocs(q);

        allReceiptsRaw = [];
        snaps.forEach(snap => {
            allReceiptsRaw.push({ id: snap.id, ...snap.data() });
        });

        console.log(`[TAX ROAD DEBUG] Loaded ${allReceiptsRaw.length} receipts`);

        allReceiptsRaw.sort((a, b) => new Date(b.date) - new Date(a.date));

        renderReceipts(allReceiptsRaw);
    } catch (error) {
        console.error("[TAX ROAD ERROR] Error fetching receipts:", error);
        showToast("Failed to load receipts.", "error");
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-error">Failed to load data</td></tr>`;
    }
}

function filterReceipts(searchTerm) {
    if (!searchTerm) {
        renderReceipts(allReceiptsRaw);
        return;
    }

    const lowerTerm = searchTerm.toLowerCase();
    const filtered = allReceiptsRaw.filter(r => {
        const inv = invoiceMap[r.invoiceId];
        const invNum = inv ? inv.invoiceNumber : '';
        const mode = r.paymentMode || '';

        return invNum.toLowerCase().includes(lowerTerm) ||
            mode.toLowerCase().includes(lowerTerm);
    });

    renderReceipts(filtered);
}

function renderReceipts(dataList) {
    if (!tbody) return;

    if (dataList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-md">No receipts found.</td></tr>`;
        return;
    }

    let html = '';
    dataList.forEach(r => {
        const inv = invoiceMap[r.invoiceId];
        const invNum = inv ? inv.invoiceNumber : 'Unknown';
        const custName = inv ? (customerMap[inv.customerId] || 'Unknown') : 'Unknown';

        html += `
            <tr data-id="${r.id}">
                <td>${formatDate(r.date)}</td>
                <td class="font-bold text-primary">${invNum}</td>
                <td>${escapeHtml(custName)}</td>
                <td><span class="badge" style="background:var(--bg-light-grey); color:var(--text-main); font-weight:normal;">${escapeHtml(r.paymentMode)}</span></td>
                <td class="font-bold text-accent">${formatCurrency(r.amountReceived || 0)}</td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

async function handleSaveReceipt(e) {
    e.preventDefault();

    const invId = invoiceSelect.value;
    const amount = Number(amountInput.value);
    const maxAmount = Number(amountInput.max);

    if (!invId) return showToast("Select an invoice", "error");
    if (amount <= 0) return showToast("Amount must be greater than 0", "error");
    if (amount > maxAmount + 0.01) { // tiny margin for float math
        return showToast(`Amount cannot exceed pending balance of ${formatCurrency(maxAmount)}`, "error");
    }

    const btnSave = document.getElementById('btn-save');

    try {
        btnSave.disabled = true;
        btnSave.textContent = 'Saving...';

        // Use batch to update invoice status and add receipt atomically
        // Using direct modular refs isn't straightforward for batch operations in simple web sdk sometimes without writeBatch imported from firestore
        // Let's import writeBatch and do it right

        const receiptData = {
            invoiceId: invId,
            amountReceived: amount,
            paymentMode: document.getElementById('receipt-mode').value,
            date: document.getElementById('receipt-date').value,
            createdAt: serverTimestamp()
        };

        // Add receipt
        await addDoc(collection(db, `users/${currentUser.uid}/receipts`), receiptData);

        // Determine new invoice status
        const invoice = invoiceMap[invId];
        const isFullPayment = Math.abs(amount - maxAmount) < 0.01;
        const newStatus = isFullPayment ? 'Paid' : 'Partially Paid';

        // Update Invoice
        const invRef = doc(db, `users/${currentUser.uid}/invoices`, invId);
        await updateDoc(invRef, {
            status: newStatus,
            updatedAt: serverTimestamp()
        });

        showToast("Payment recorded successfully");
        closeModal();

        // Reload all data to reflect status changes
        await loadCustomersAndInvoices();
        await fetchReceipts();

    } catch (error) {
        console.error("Error saving receipt:", error);
        showToast("Error saving receipt", "error");
    } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
            Save Receipt
        `;
    }
}

// Utils
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return typeof unsafe === 'string' ? unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;") : unsafe;
}

initReceipts();
