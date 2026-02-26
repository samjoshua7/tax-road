import { auth, db, onAuthStateChanged, collection, query, getDocs, addDoc, updateDoc, deleteDoc, doc, getDoc, serverTimestamp, signOut, runTransaction, where, orderBy } from './firebase-config.js';
import { loadComponents, showToast, formatCurrency, formatDate, setPageTitle, showLoadingRow, hideLoadingRow } from './utils.js';

let currentUser = null;
let allReceiptsRaw = [];
let pendingInvoices = []; // For dropdown
let invoiceMap = {}; // id -> invoice data
let customerMap = {}; // id -> name

// DOM
const tbody = document.getElementById('receipts-body');
const modal = document.getElementById('receipt-modal');
const modalTitle = document.getElementById('modal-title');   // ✅ FIX: was missing, caused ReferenceError
const form = document.getElementById('receipt-form');
const btnAdd = document.getElementById('btn-add-receipt');
const btnClose = document.getElementById('modal-close');
const btnCancel = document.getElementById('btn-cancel');
const invoiceSelect = document.getElementById('receipt-invoice');
const amountInput = document.getElementById('receipt-amount');

// Init
async function initReceipts() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = 'index.html';
            return;
        }

        currentUser = user;

        await loadComponents();
        setupNavigation();

        // Load profile and reference data in parallel
        await Promise.all([loadUserProfile(), loadCustomersAndInvoices()]);

        setupEventListeners();
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

    // Attach Edit/Delete Listeners — delegated at document for robustness
    document.addEventListener('click', (e) => {
        const btnEdit = e.target.closest && e.target.closest('.btn-edit');
        const btnDelete = e.target.closest && e.target.closest('.btn-delete');

        if (btnEdit) {
            if (btnEdit.disabled) {
                console.log('[TAX ROAD DEBUG] Receipt Edit clicked but disabled.');
                return;
            }
            const tr = btnEdit.closest('tr');
            if (!tr) return;
            const id = tr.dataset.id;
            console.log('[TAX ROAD DEBUG] Receipt Edit clicked for id:', id);
            const receipt = allReceiptsRaw.find(r => r.id === id);
            if (receipt) openModalForEdit(receipt);
            else console.warn('[TAX ROAD WARN] Receipt not found for edit:', id);
        }

        if (btnDelete) {
            if (btnDelete.disabled) {
                console.log('[TAX ROAD DEBUG] Receipt Delete clicked but disabled.');
                return;
            }
            const tr = btnDelete.closest('tr');
            if (!tr) return;
            const id = tr.dataset.id;
            console.log('[TAX ROAD DEBUG] Receipt Delete clicked for id:', id);
            const receipt = allReceiptsRaw.find(r => r.id === id);
            if (receipt) {
                handleDeleteReceipt(receipt).catch(err => {
                    console.error('[TAX ROAD ERROR] handleDeleteReceipt failed:', err);
                    showToast('Failed to delete receipt: ' + (err && err.message ? err.message : ''), 'error');
                });
            } else console.warn('[TAX ROAD WARN] Receipt not found for delete:', id);
        }
    });

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
    document.getElementById('receipt-id').value = '';
    document.getElementById('receipt-amount').readOnly = false;
    document.getElementById('receipt-invoice').disabled = false;
    modalTitle.textContent = 'Record Payment';

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

function openModalForEdit(receipt) {
    document.getElementById('receipt-id').value = receipt.id;
    document.getElementById('receipt-amount').value = receipt.amountReceived;
    document.getElementById('receipt-mode').value = receipt.paymentMode;
    document.getElementById('receipt-date').value = receipt.date;

    // Prevent changing the invoice entirely for an existing receipt to avoid complex dual-ledger balancing
    invoiceSelect.innerHTML = `<option value="${receipt.invoiceId}">Invoice tied to this receipt</option>`;
    document.getElementById('receipt-invoice').value = receipt.invoiceId;
    document.getElementById('receipt-invoice').disabled = true;

    // We allow amount editing, but we must validate max loosely or handle it strictly.
    // For MVP, allow them to edit the amount.
    document.getElementById('receipt-amount').max = "";
    document.getElementById('invoice-balance-info').classList.add('hidden');
    modalTitle.textContent = `Edit Payment - ${receipt.receiptNumber || 'N/A'}`;

    modal.classList.add('active');
}

async function generateSafeReceiptNumber() {
    console.log('[TAX ROAD DEBUG] Generating safe transaction-based receipt number...');
    const counterRef = doc(db, `users/${currentUser.uid}/counters/receipts`);
    let newSequence = 1;

    await runTransaction(db, async (transaction) => {
        const counterDoc = await transaction.get(counterRef);
        if (!counterDoc.exists()) {
            // First ever receipt
            transaction.set(counterRef, { currentCount: 1 });
            newSequence = 1;
        } else {
            const data = counterDoc.data();
            newSequence = (data.currentCount || 0) + 1;
            transaction.update(counterRef, { currentCount: newSequence });
        }
    });

    return `REC-${String(newSequence).padStart(4, '0')}`;
}

function closeModal() {
    modal.classList.remove('active');
    form.reset();
}

async function fetchReceipts() {
    try {
        console.log('[TAX ROAD DEBUG] Fetching receipts from Firestore...');

        // Show loading state
        if (tbody) {
            showLoadingRow(tbody, 7, 'Loading receipts...');
        }

        const q = query(collection(db, `users/${currentUser.uid}/receipts`), orderBy('date', 'desc'));
        const snaps = await getDocs(q);

        allReceiptsRaw = [];
        snaps.forEach(snap => {
            allReceiptsRaw.push({ id: snap.id, ...snap.data() });
        });

        console.log(`[TAX ROAD DEBUG] Loaded ${allReceiptsRaw.length} receipts`);
        // already ordered by date desc from Firestore query

        if (tbody) hideLoadingRow(tbody);
        renderReceipts(allReceiptsRaw);
    } catch (error) {
        console.error("[TAX ROAD ERROR] Error fetching receipts:", error);
        showToast("Failed to load receipts.", "error");
        if (tbody) {
            tbody.closest('.table-container').style.opacity = '1';
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-error">Failed to load data</td></tr>`;
        }
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
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-md">No receipts found.</td></tr>`;
        return;
    }

    let html = '';
    dataList.forEach(r => {
        const inv = invoiceMap[r.invoiceId];
        const invNum = inv ? inv.invoiceNumber : 'Unknown';
        const custName = inv ? (customerMap[inv.customerId] || 'Unknown') : 'Unknown';

        const receiptNum = r.receiptNumber || 'N/A';
        html += `
            <tr data-id="${r.id}">
                <td>${formatDate(r.date)}</td>
                <td class="font-bold text-accent">${receiptNum}</td>
                <td class="font-bold text-primary">${invNum}</td>
                <td>${escapeHtml(custName)}</td>
                <td><span class="badge" style="background:var(--bg-light-grey); color:var(--text-main); font-weight:normal;">${escapeHtml(r.paymentMode)}</span></td>
                <td class="font-bold">${formatCurrency(r.amountReceived || 0)}</td>
                <td class="actions-cell">
                    <button class="btn btn-outline btn-edit" style="padding: 6px; border-color: var(--accent); color: var(--accent);" title="Edit">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                    </button>
                    <button class="btn btn-outline btn-delete" style="padding: 6px; border-color: var(--text-error); color: var(--text-error);" title="Delete">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

async function handleSaveReceipt(e) {
    e.preventDefault();

    const id = document.getElementById('receipt-id').value;
    const invId = document.getElementById('receipt-invoice').value;
    const amount = Number(amountInput.value);
    const maxAmount = Number(amountInput.max);

    if (!invId) return showToast("Select an invoice", "error");
    if (amount <= 0) return showToast("Amount must be greater than 0", "error");

    // Only check max amount rigidly if creating a new receipt (maxAmount is parsed from input.max)
    if (!id && maxAmount > 0 && amount > maxAmount + 0.01) {
        return showToast(`Amount cannot exceed pending balance of ${formatCurrency(maxAmount)}`, "error");
    }

    const btnSave = document.getElementById('btn-save');

    try {
        btnSave.disabled = true;
        btnSave.textContent = 'Saving...';

        const receiptRef = collection(db, `users/${currentUser.uid}/receipts`);

        let newOrUpdatedReceiptNum = "N/A";

        if (id) {
            // Updating existing receipt
            const existingReceipt = allReceiptsRaw.find(r => r.id === id);
            newOrUpdatedReceiptNum = existingReceipt.receiptNumber || 'N/A';

            const docRef = doc(db, `users/${currentUser.uid}/receipts`, id);
            await updateDoc(docRef, {
                amountReceived: amount,
                paymentMode: document.getElementById('receipt-mode').value,
                date: document.getElementById('receipt-date').value,
                updatedAt: serverTimestamp()
            });
            showToast("Payment updated successfully");

        } else {
            // Create new receipt
            newOrUpdatedReceiptNum = await generateSafeReceiptNumber();

            const receiptData = {
                invoiceId: invId,
                receiptNumber: newOrUpdatedReceiptNum,
                amountReceived: amount,
                paymentMode: document.getElementById('receipt-mode').value,
                date: document.getElementById('receipt-date').value,
                createdAt: serverTimestamp()
            };

            await addDoc(receiptRef, receiptData);
            showToast("Payment recorded successfully");
        }

        // --- LEDGER RECALCULATION (CRITICAL) ---
        // Recalculate invoice status strictly based on *all* receipts for this invoice
        await recalculateInvoiceState(invId);

        closeModal();
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

async function handleDeleteReceipt(receipt) {
    if (!confirm(`Are you sure you want to delete receipt ${receipt.receiptNumber || 'N/A'}?`)) {
        return;
    }

    try {
        const docRef = doc(db, `users/${currentUser.uid}/receipts`, receipt.id);
        await deleteDoc(docRef);
        showToast("Receipt deleted successfully");

        // --- LEDGER RECALCULATION (CRITICAL) ---
        await recalculateInvoiceState(receipt.invoiceId);

        await loadCustomersAndInvoices();
        await fetchReceipts();
    } catch (error) {
        console.error("Error deleting receipt:", error);
        showToast("Error deleting receipt", "error");
    }
}

// Ledger consistency function
async function recalculateInvoiceState(invId) {
    console.log(`[TAX ROAD DEBUG] Recalculating ledger for invoice ${invId}`);

    // 1. Fetch exact total from the invoice doc
    const invRef = doc(db, `users/${currentUser.uid}/invoices`, invId);
    const invDoc = await getDoc(invRef);
    if (!invDoc.exists()) return;

    const invTotal = Number(invDoc.data().total) || 0;

    // 2. Sum ALL receipts currently in DB for this invoice
    const rQ = query(collection(db, `users/${currentUser.uid}/receipts`), where("invoiceId", "==", invId));
    const rSnaps = await getDocs(rQ);

    let totalPaid = 0;
    rSnaps.forEach(snap => {
        totalPaid += Number(snap.data().amountReceived) || 0;
    });

    // 3. Determine status
    let newStatus = 'Pending';
    if (totalPaid > 0) {
        // give a tiny float gap 0.01 for JS math
        if (Math.abs(invTotal - totalPaid) < 0.01 || totalPaid > invTotal) {
            newStatus = 'Paid';
        } else {
            newStatus = 'Partially Paid';
        }
    }

    // 4. Update the parent invoice
    await updateDoc(invRef, {
        status: newStatus,
        updatedAt: serverTimestamp()
    });
    console.log(`[TAX ROAD DEBUG] Invoice ${invId} recalculated. Paid: ${totalPaid}, Status: ${newStatus}`);
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
