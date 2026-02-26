import { auth, db, onAuthStateChanged, collection, query, getDocs, addDoc, updateDoc, doc, deleteDoc, serverTimestamp, getDoc, signOut, where, runTransaction, orderBy } from './firebase-config.js';
import { loadComponents, showToast, formatCurrency, formatDate, setPageTitle, showLoadingRow, hideLoadingRow } from './utils.js';

let currentUser = null;
let allInvoicesRaw = [];
let customersMap = {}; // id -> name mapping
let customersDataMap = {}; // id -> full customer data
let currentLineItems = []; // Array of objects matching Firestore schema
let invoiceHasReceipt = {}; // map invoiceId -> boolean
let currentBusinessName = '';
let currentUpiId = '';

// DOM Elements
const tbody = document.getElementById('invoices-body');
const searchInput = document.getElementById('global-search');
const modal = document.getElementById('invoice-modal');
const form = document.getElementById('invoice-form');
const btnCreate = document.getElementById('btn-create-invoice');
const btnClose = document.getElementById('modal-close');
const btnCancel = document.getElementById('btn-cancel');
const modalTitle = document.getElementById('modal-title');
const btnAddItem = document.getElementById('btn-add-item');
const itemsContainer = document.getElementById('invoice-items-container');
const customerSelect = document.getElementById('inv-customer');

// Initialize
async function initInvoices() {
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = 'index.html';
            return;
        }

        currentUser = user;

        await loadComponents();
        setupNavigation();
        setupEventListeners();

        // Load profile and customers in parallel — customers must finish before fetchInvoices for the map to be ready
        await Promise.all([loadUserProfile(), loadCustomers()]);
        await fetchInvoices();
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
    setPageTitle('Invoices');

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
            console.log(`[TAX ROAD DEBUG] Searching invoices for: ${e.target.value}`);
            filterInvoices(e.target.value);
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
                currentBusinessName = userData.businessName || '';
                currentUpiId = userData.upiId || '';
                const nameDisplay = document.getElementById('user-display-name');
                if (nameDisplay && currentBusinessName) {
                    nameDisplay.textContent = currentBusinessName;
                    nameDisplay.style.display = 'block';
                }
            } else {
            console.warn('[TAX ROAD WARN] No user profile found in Firestore');
        }
    } catch (e) {
        console.error('[TAX ROAD ERROR] Error loading user profile:', e);
    }
}

async function loadCustomers() {
    try {
        console.log('[TAX ROAD DEBUG] Loading customers into invoice form...');
        const q = query(collection(db, `users/${currentUser.uid}/customers`));
        const snaps = await getDocs(q);

        customersMap = {};
        customersDataMap = {};
        customerSelect.innerHTML = '<option value="">Select Customer</option>';

        const sortedCustomers = [];
        snaps.forEach(snap => {
            const data = snap.data();
            customersMap[snap.id] = data.partyName;
            customersDataMap[snap.id] = data;
            sortedCustomers.push({ id: snap.id, name: data.partyName });
        });

        console.log(`[TAX ROAD DEBUG] Loaded ${sortedCustomers.length} customers for invoice form`);

        sortedCustomers.sort((a, b) => a.name.localeCompare(b.name));

        sortedCustomers.forEach(c => {
            const option = document.createElement('option');
            option.value = c.id;
            option.textContent = c.name;
            customerSelect.appendChild(option);
        });
    } catch (e) {
        console.error("[TAX ROAD ERROR] Error loading customers", e);
    }
}

function setupEventListeners() {
    btnCreate.addEventListener('click', () => {
        openModal(null, "Auto-generated upon save");
    });
    btnClose.addEventListener('click', closeModal);
    btnCancel.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // View modal close on outside click
    const viewModal = document.getElementById('view-invoice-modal');
    viewModal.addEventListener('click', (e) => {
        if (e.target === viewModal) closeViewModal();
    });

    form.addEventListener('submit', handleSaveInvoice);
    btnAddItem.addEventListener('click', () => {
        addLineItemUI();
    });

    // Setup delegation for deleting items and updating calculations
    itemsContainer.addEventListener('input', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
            calculateTotals();
        }
    });

    itemsContainer.addEventListener('click', (e) => {
        const btnDelete = e.target.closest('.btn-delete-item');
        if (btnDelete) {
            const row = btnDelete.closest('.line-item-row');
            if (row) {
                row.remove();
                calculateTotals();
            }
        }
    });

    // Table Edit/Delete/View — delegated at document level to ensure handlers always fire
    document.addEventListener('click', async (e) => {
        const btnView = e.target.closest && e.target.closest('.btn-view');
        const btnEdit = e.target.closest && e.target.closest('.btn-edit');
        const btnDel = e.target.closest && e.target.closest('.btn-delete');

        if (btnView) {
            const tr = btnView.closest('tr[data-id]');
            if (!tr) return;
            const invoiceId = tr.dataset.id;
            console.log('[TAX ROAD DEBUG] View clicked for invoice id:', invoiceId);
            const invoice = allInvoicesRaw.find(i => i.id === invoiceId);
            if (invoice) openViewModal(invoice);
            else console.warn('[TAX ROAD WARN] Invoice not found for view:', invoiceId);
        }

        if (btnEdit) {
            const tr = btnEdit.closest('tr[data-id]');
            if (!tr) return;
            const invoiceId = tr.dataset.id;
            console.log('[TAX ROAD DEBUG] Edit clicked for invoice id:', invoiceId);
            const invoice = allInvoicesRaw.find(i => i.id === invoiceId);
            if (!invoice) {
                console.warn('[TAX ROAD WARN] Invoice not found for edit:', invoiceId);
                return;
            }
            // check if any receipts are linked (fast map)
            if (invoiceHasReceipt[invoiceId]) {
                showToast('Cannot edit invoice – receipts are linked. Delete receipts first.', 'error');
                return;
            }
            // double-check with server in case map is stale
            try {
                const receiptsRef = collection(db, `users/${currentUser.uid}/receipts`);
                const rSnaps = await getDocs(query(receiptsRef, where('invoiceId', '==', invoiceId)));
                if (!rSnaps.empty) {
                    showToast('Cannot edit invoice – receipts are linked. Delete receipts first.', 'error');
                    return;
                }
            } catch (err) {
                console.error('[TAX ROAD ERROR] checking receipts before edit:', err);
                // fall through and allow edit to avoid blocking unreasonably
            }
            openModal(invoice);
        }

        if (btnDel) {
            const tr = btnDel.closest('tr[data-id]');
            if (!tr) return;
            const invoiceId = tr.dataset.id;
            console.log('[TAX ROAD DEBUG] Delete clicked for invoice id:', invoiceId);
            const invoice = allInvoicesRaw.find(i => i.id === invoiceId);
            if (!invoice) {
                console.warn('[TAX ROAD WARN] Invoice not found for delete:', invoiceId);
                return;
            }
            // fast map check first
            if (invoiceHasReceipt[invoiceId]) {
                showToast('Cannot delete invoice – receipts are linked. Delete receipts first.', 'error');
                return;
            }
            // double check against server to be safe
            try {
                const receiptsRef = collection(db, `users/${currentUser.uid}/receipts`);
                const rSnaps = await getDocs(query(receiptsRef, where('invoiceId', '==', invoiceId)));
                if (!rSnaps.empty) {
                    showToast('Cannot delete invoice – receipts are linked. Delete receipts first.', 'error');
                    return;
                }
            } catch (err) {
                console.error('[TAX ROAD ERROR] checking receipts before delete:', err);
            }
            handleDelete(invoice).catch(err => {
                console.error('[TAX ROAD ERROR] handleDelete failed:', err);
                showToast('Failed to delete invoice: ' + (err && err.message ? err.message : ''), 'error');
            });
        }
    });
}

async function generateSafeInvoiceNumber() {
    console.log('[TAX ROAD DEBUG] Generating safe transaction-based invoice number...');
    const counterRef = doc(db, `users/${currentUser.uid}/counters/invoices`);
    let newSequence = 1;

    await runTransaction(db, async (transaction) => {
        const counterDoc = await transaction.get(counterRef);
        if (!counterDoc.exists()) {
            // First ever invoice
            transaction.set(counterRef, { currentCount: 1 });
            newSequence = 1;
        } else {
            const data = counterDoc.data();
            newSequence = (data.currentCount || 0) + 1;
            transaction.update(counterRef, { currentCount: newSequence });
        }
    });

    return `INV-${String(newSequence).padStart(4, '0')}`;
}

function openModal(invoice = null, prefilledNumber = '') {
    itemsContainer.innerHTML = ''; // Clear items

    if (invoice) {
        modalTitle.textContent = 'Edit Invoice';
        document.getElementById('invoice-id').value = invoice.id;
        document.getElementById('inv-customer').value = invoice.customerId;
        document.getElementById('inv-number').value = invoice.invoiceNumber;
        // Handle Firestore Timestamp objects (.toDate()) and ISO strings
        const rawDate = invoice.createdAt;
        let parsedDate;
        if (rawDate && typeof rawDate === 'object' && typeof rawDate.toDate === 'function') {
            parsedDate = rawDate.toDate();
        } else if (rawDate) {
            parsedDate = new Date(rawDate);
        } else {
            parsedDate = new Date();
        }
        document.getElementById('inv-date').value = isNaN(parsedDate) ? new Date().toISOString().split('T')[0] : parsedDate.toISOString().split('T')[0];

        // Load existing items
        if (invoice.items && invoice.items.length > 0) {
            invoice.items.forEach(item => addLineItemUI(item));
        } else {
            addLineItemUI(); // At least one empty row
        }

    } else {
        modalTitle.textContent = 'Create Invoice';
        form.reset();
        document.getElementById('invoice-id').value = '';
        document.getElementById('inv-number').value = prefilledNumber;
        document.getElementById('inv-date').value = new Date().toISOString().split('T')[0];
        addLineItemUI(); // Start with one empty row
    }

    calculateTotals();
    modal.classList.add('active');
}

function closeModal() {
    modal.classList.remove('active');
    form.reset();
    itemsContainer.innerHTML = '';
}

function addLineItemUI(itemData = null) {
    const defaultItem = { name: '', quantity: 1, price: 0, gstPercent: 18 };
    const item = itemData || defaultItem;

    const div = document.createElement('div');
    div.className = 'line-item-row';

    div.innerHTML = `
        <div class="form-group" style="margin-bottom:0;">
            <input type="text" class="form-control item-name" placeholder="Item description" required value="${escapeHtml(item.name)}">
        </div>
        <div class="form-group" style="margin-bottom:0;">
            <input type="number" class="form-control item-qty" min="0.01" step="0.01" placeholder="Qty" required value="${item.quantity}">
        </div>
        <div class="form-group" style="margin-bottom:0;">
            <input type="number" class="form-control item-price" min="0" step="0.01" placeholder="Price" required value="${item.price}">
        </div>
        <div class="form-group" style="margin-bottom:0;">
            <select class="form-control item-gst">
                <option value="0" ${item.gstPercent === 0 ? 'selected' : ''}>0%</option>
                <option value="5" ${item.gstPercent === 5 ? 'selected' : ''}>5%</option>
                <option value="12" ${item.gstPercent === 12 ? 'selected' : ''}>12%</option>
                <option value="18" ${item.gstPercent === 18 ? 'selected' : ''}>18%</option>
                <option value="28" ${item.gstPercent === 28 ? 'selected' : ''}>28%</option>
            </select>
        </div>
        <button type="button" class="btn btn-outline btn-delete-item" style="padding: 10px; border-color: var(--text-error); color: var(--text-error);">
            <svg class="icon" viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
    `;

    itemsContainer.appendChild(div);
}

function calculateTotals() {
    let subtotal = 0;
    let gstAmount = 0;

    const rows = itemsContainer.querySelectorAll('.line-item-row');
    rows.forEach(row => {
        const qty = parseFloat(row.querySelector('.item-qty').value) || 0;
        const price = parseFloat(row.querySelector('.item-price').value) || 0;
        const gstPct = parseFloat(row.querySelector('.item-gst').value) || 0;

        const lineVal = qty * price;
        const lineGst = lineVal * (gstPct / 100);

        subtotal += lineVal;
        gstAmount += lineGst;
    });

    const total = subtotal + gstAmount;

    document.getElementById('inv-subtotal').textContent = formatCurrency(subtotal);
    document.getElementById('inv-gst').textContent = formatCurrency(gstAmount);
    document.getElementById('inv-total').textContent = formatCurrency(total);

    return { subtotal, gstAmount, total };
}

async function fetchInvoices() {
    try {
        console.log('[TAX ROAD DEBUG] Fetching invoices from Firestore...');

        // Show loading state
        if (tbody) {
            showLoadingRow(tbody, 6, 'Loading invoices...');
        }

        const invoicesRef = collection(db, `users/${currentUser.uid}/invoices`);
        // order by date descending reduces work client-side
        const q = query(invoicesRef, orderBy('createdAt', 'desc'));
        const snaps = await getDocs(q);

        allInvoicesRaw = [];
        snaps.forEach(snap => {
            allInvoicesRaw.push({ id: snap.id, ...snap.data() });
        });

        console.log(`[TAX ROAD DEBUG] Loaded ${allInvoicesRaw.length} invoices`);
        // data already ordered by createdAt desc via Firestore query

        // Build quick lookup of receipts per invoice to avoid extra DB calls when rendering
        invoiceHasReceipt = {};
        try {
            const receiptsRef = collection(db, `users/${currentUser.uid}/receipts`);
            const rSnaps = await getDocs(receiptsRef);
            rSnaps.forEach(rsnap => {
                const invId = rsnap.data().invoiceId;
                if (invId) invoiceHasReceipt[invId] = true;
            });
            console.log(`[TAX ROAD DEBUG] invoiceHasReceipt map size: ${Object.keys(invoiceHasReceipt).length}`);
        } catch (err) {
            console.error('[TAX ROAD ERROR] building invoiceHasReceipt map:', err);
        }

        if (tbody) hideLoadingRow(tbody);
        renderInvoices(allInvoicesRaw);
    } catch (error) {
        console.error("[TAX ROAD ERROR] Error fetching invoices:", error);
        showToast("Failed to load invoices.", "error");
        if (tbody) {
            tbody.closest('.table-container').style.opacity = '1';
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-error">Failed to load data</td></tr>`;
        }
    }
}

function filterInvoices(searchTerm) {
    if (!searchTerm) {
        renderInvoices(allInvoicesRaw);
        return;
    }

    const lowerTerm = searchTerm.toLowerCase();
    const filtered = allInvoicesRaw.filter(inv => {
        const custName = customersMap[inv.customerId] || '';
        return (inv.invoiceNumber && inv.invoiceNumber.toLowerCase().includes(lowerTerm)) ||
            (custName.toLowerCase().includes(lowerTerm));
    });

    renderInvoices(filtered);
}

function renderInvoices(dataList) {
    if (!tbody) return;

    if (dataList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-md">No invoices found.</td></tr>`;
        return;
    }

    let html = '';
    dataList.forEach(inv => {
        const custName = escapeHtml(customersMap[inv.customerId] || 'Unknown Customer');
        const statusClass = inv.status === 'Paid' ? 'badge-success' :
            inv.status === 'Partially Paid' ? 'badge-warning' : 'badge-error';
        const displayStatus = inv.status || 'Pending';

        const hasReceipt = !!invoiceHasReceipt[inv.id];
        const disableNote = hasReceipt ? 'title="Receipts linked – delete receipts to modify/delete."' : '';
        const btnClassExtra = hasReceipt ? 'btn-disabled' : '';
        html += `
            <tr data-id="${inv.id}" ${hasReceipt ? 'class="row-paid"' : ''}>
                <td class="font-bold text-primary">${inv.invoiceNumber}</td>
                <td>${custName}</td>
                <td>${formatDate(inv.createdAt)}</td>
                <td class="font-bold">${formatCurrency(inv.total || 0)}</td>
                <td><span class="badge ${statusClass}">${displayStatus}</span></td>
                <td class="actions-cell">
                    <button class="btn btn-outline btn-view" style="padding: 6px; border-color: var(--primary); color: var(--primary);" title="View">
                        <svg class="icon" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
                    </button>
                    <button class="btn btn-outline btn-edit ${btnClassExtra}" style="padding: 6px; border-color: var(--accent); color: var(--accent);" ${disableNote}>
                        <svg class="icon" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                    </button>
                    <button class="btn btn-outline btn-delete ${btnClassExtra}" style="padding: 6px; border-color: var(--text-error); color: var(--text-error);" ${disableNote}>
                        <svg class="icon" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                    </button>
                </td>
            </tr>
        `;
    });

    tbody.innerHTML = html;
}

function gatherLineItems() {
    const items = [];
    const rows = itemsContainer.querySelectorAll('.line-item-row');

    rows.forEach(row => {
        const name = row.querySelector('.item-name').value.trim();
        const qty = parseFloat(row.querySelector('.item-qty').value) || 0;
        const price = parseFloat(row.querySelector('.item-price').value) || 0;
        const gstPct = parseFloat(row.querySelector('.item-gst').value) || 0;

        if (name && qty > 0) {
            items.push({ name, quantity: qty, price, gstPercent: gstPct });
        }
    });

    return items;
}

async function handleSaveInvoice(e) {
    e.preventDefault();

    const customerId = document.getElementById('inv-customer').value;
    if (!customerId) {
        showToast("Please select a customer.", "error");
        return;
    }

    const items = gatherLineItems();
    if (items.length === 0) {
        showToast("Please add at least one line item.", "error");
        return;
    }

    const { subtotal, gstAmount, total } = calculateTotals();
    const btnSave = document.getElementById('btn-save');
    const id = document.getElementById('invoice-id').value;
    const invNumber = document.getElementById('inv-number').value;
    const invDateStr = document.getElementById('inv-date').value;

    const invoiceData = {
        customerId,
        items,
        subtotal,
        gstAmount,
        total,
        // Convert yyyy-mm-dd to ISO UTC for consistency, or store as string if parsing is needed
        createdAt: new Date(invDateStr).toISOString()
    };

    try {
        btnSave.disabled = true;
        btnSave.textContent = 'Saving...';

        const invRef = collection(db, `users/${currentUser.uid}/invoices`);

        if (id) {
            // Update
            const existingInv = allInvoicesRaw.find(i => i.id === id);
            invoiceData.invoiceNumber = existingInv.invoiceNumber; // Ensure number doesn't disappear
            // Keep existing status for now - it will be recalculated below
            invoiceData.status = existingInv.status || 'Pending';

            const docRef = doc(db, `users/${currentUser.uid}/invoices`, id);
            await updateDoc(docRef, {
                ...invoiceData,
                updatedAt: serverTimestamp()
            });
            showToast("Invoice updated successfully");

            // Recalculate status in case totals changed relative to existing receipts
            await recalculateInvoiceState(id);
        } else {
            // Create New - Lock transaction and assign number
            const finalInvNum = await generateSafeInvoiceNumber();
            invoiceData.status = 'Pending';
            invoiceData.invoiceNumber = finalInvNum;

            await addDoc(invRef, {
                ...invoiceData
            });
            showToast("Invoice created successfully");
        }

        closeModal();
        await fetchInvoices();

    } catch (error) {
        console.error("Error saving invoice:", error);
        showToast("Error saving invoice", "error");
    } finally {
        btnSave.disabled = false;
        btnSave.innerHTML = `
            <svg class="icon" viewBox="0 0 24 24"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>
            Save Invoice
        `;
    }
}

async function handleDelete(invoice) {
    // additional guard: use map to avoid unnecessary query
    if (invoiceHasReceipt[invoice.id]) {
        showToast('Invoice cannot be deleted because receipts are linked.', 'error');
        return;
    }

    if (!confirm(`Are you sure you want to delete invoice ${invoice.invoiceNumber}? This action cannot be undone.`)) {
        return;
    }

    // CHECK RULE 2: Invoice cannot be deleted if receipts exist
    try {
        const receiptsRef = collection(db, `users/${currentUser.uid}/receipts`);
        const q = query(receiptsRef, where("invoiceId", "==", invoice.id));
        const snaps = await getDocs(q);

        if (!snaps.empty) {
            showToast("Invoice cannot be deleted because receipts are linked.", "error");
            return;
        }

        // Proceed with deletion since receipt_count == 0
        const docRef = doc(db, `users/${currentUser.uid}/invoices`, invoice.id);
        await deleteDoc(docRef);
        showToast("Invoice deleted successfully");
        await fetchInvoices();
    } catch (error) {
        console.error("Error deleting invoice:", error);
        showToast("Error deleting invoice", "error");
    }
}

// View Invoice Modal functions
function openViewModal(invoice) {
    const modal = document.getElementById('view-invoice-modal');
    const preview = document.getElementById('invoice-preview');
    
    // Render A4 invoice HTML
    const customerName = customersMap[invoice.customerId] || 'Unknown Customer';
    const itemsHtml = (invoice.items || []).map(item => `
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #ddd;">${escapeHtml(item.name)}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${item.quantity}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">₹${((item.price || 0).toFixed(2))}</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">${item.gstPercent || 0}%</td>
            <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">₹${(((item.quantity || 0) * (item.price || 0) * (1 + (item.gstPercent || 0) / 100)).toFixed(2))}</td>
        </tr>
    `).join('');

    const invoiceDate = formatDate(invoice.createdAt);
    const invoiceQrId = `invoice-qr-${invoice.id}`;
    const invoiceHtml = `
        <div style="margin-bottom: 20px; border-bottom: 2px solid #333; padding-bottom: 15px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <h1 style="margin: 0 0 5px 0; font-size: 24pt; color: var(--primary);">${escapeHtml(currentBusinessName || 'Business')}</h1>
                    <p style="margin: 0; font-size: 9pt; color: var(--text-muted);">Smart Billing for GST Compliance</p>
                </div>
                <div style="text-align: right;">
                    <h2 style="margin: 0; font-size: 18pt; color: var(--primary);">INVOICE</h2>
                    <p style="margin: 5px 0 0 0; font-size: 10pt;">No. ${escapeHtml(invoice.invoiceNumber)}</p>
                </div>
            </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; font-size: 10pt;">
            <div>
                <p style="margin: 0 0 10px 0; font-weight: bold; color: var(--primary);">BILL TO</p>
                <p style="margin: 0;"><strong>${escapeHtml(customerName)}</strong></p>
            </div>
            <div style="text-align: right;">
                <p style="margin: 0;"><strong>Invoice Date:</strong> ${invoiceDate}</p>
                <p style="margin: 5px 0 0 0;"><strong>Status:</strong> ${escapeHtml(invoice.status || 'Pending')}</p>
            </div>
        </div>

        <table style="width: 100%; margin-bottom: 20px; border-collapse: collapse;">
            <thead>
                <tr style="background: var(--bg-light-grey);">
                    <th style="padding: 10px; text-align: left; border-bottom: 2px solid #333; font-weight: bold;">Item Description</th>
                    <th style="padding: 10px; text-align: right; border-bottom: 2px solid #333; font-weight: bold;">Qty</th>
                    <th style="padding: 10px; text-align: right; border-bottom: 2px solid #333; font-weight: bold;">Unit Price</th>
                    <th style="padding: 10px; text-align: right; border-bottom: 2px solid #333; font-weight: bold;">GST %</th>
                    <th style="padding: 10px; text-align: right; border-bottom: 2px solid #333; font-weight: bold;">Total</th>
                </tr>
            </thead>
            <tbody>
                ${itemsHtml}
            </tbody>
        </table>

        <div style="display: flex; justify-content: flex-end; margin-bottom: 20px;">
            <div style="width: 250px;">
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid #ddd;">
                    <span>Subtotal:</span>
                    <strong>₹${((invoice.subtotal || 0).toFixed(2))}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 8px 0;">
                    <span>GST (Tax):</span>
                    <strong>₹${((invoice.gstAmount || 0).toFixed(2))}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 8px 0; border-top: 2px solid #333; font-weight: bold; font-size: 12pt;">
                    <span>TOTAL:</span>
                    <strong>₹${((invoice.total || 0).toFixed(2))}</strong>
                </div>
            </div>
        </div>

        <div style="margin-top: 30px; padding-top: 15px; border-top: 1px solid #ddd; font-size: 9pt; color: var(--text-muted);">
            <p style="margin: 0 0 5px 0;"><strong>Payment Instructions:</strong></p>
            <div style="display:flex; gap:16px; align-items:center; margin-top:8px;">
                <div id="${invoiceQrId}" style="width:120px; height:120px; border:1px solid #f0f0f0; display:flex; align-items:center; justify-content:center; background:#fff;"></div>
                <div>
                    <p style="margin: 0;">Scan the QR code to pay online or use your preferred payment method.</p>
                    <p style="margin: 5px 0 0 0;">UPI: ${escapeHtml(currentUpiId || '')}</p>
                </div>
            </div>
            <p style="margin: 5px 0 0 0;">Thank you for your business! Please retain this invoice for your records.</p>
        </div>
    `;

    preview.innerHTML = invoiceHtml;

    // Generate QR code for UPI payment (use dynamic UPI ID and business name)
    const upiId = currentUpiId || '';
    const qrContainer = document.getElementById('qr-code-container');
    qrContainer.innerHTML = ''; // Clear previous QR

    const payeeName = currentBusinessName || '';
    const upiUrl = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${invoice.total}&cu=INR&tn=Invoice-${encodeURIComponent(invoice.invoiceNumber)}`;

    // QR inside modal footer
    new QRCode(qrContainer, {
        text: upiUrl,
        width: 150,
        height: 150,
        colorDark: '#000000',
        colorLight: '#ffffff',
    });

    document.getElementById('qr-upi-text').textContent = upiId;

    // QR inside invoice preview (so embedded in PDF/image)
    try {
        const invoiceInnerQr = document.getElementById(invoiceQrId);
        if (invoiceInnerQr) {
            invoiceInnerQr.innerHTML = '';
            new QRCode(invoiceInnerQr, {
                text: upiUrl,
                width: 120,
                height: 120,
                colorDark: '#000000',
                colorLight: '#ffffff',
            });
        }
    } catch (err) {
        console.error('[TAX ROAD ERROR] generating invoice inner QR:', err);
    }

    // Setup download button
    document.getElementById('btn-download-pdf').onclick = () => {
        downloadInvoicePDF(invoice);
    };

    // Setup download image button (if present)
    const imgBtn = document.getElementById('btn-download-image');
    if (imgBtn) imgBtn.onclick = () => {
        downloadInvoiceImage(invoice);
    };

    // Setup WhatsApp button
    document.getElementById('btn-whatsapp').onclick = () => {
        sendOnWhatsApp(invoice, customerName);
    };

    // Setup modal close
    document.getElementById('view-modal-close').onclick = closeViewModal;
    
    modal.classList.add('active');
}

function closeViewModal() {
    const modal = document.getElementById('view-invoice-modal');
    modal.classList.remove('active');
}

function downloadInvoicePDF(invoice) {
    const element = document.getElementById('invoice-preview');
    const customerName = customersMap[invoice.customerId] || 'Unknown';
    const filename = `Invoice_${invoice.invoiceNumber}_${customerName}.pdf`;

    const opt = {
        margin: 5,
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    html2pdf().set(opt).from(element).save();
}

function downloadInvoiceImage(invoice) {
    const element = document.getElementById('invoice-preview');
    const customerName = customersMap[invoice.customerId] || 'Unknown';
    const filename = `Invoice_${invoice.invoiceNumber}_${customerName}.png`;

    // Use html2canvas (bundled by html2pdf) to render high-res image
    try {
        html2canvas(element, { scale: 2, useCORS: true }).then(canvas => {
            canvas.toBlob((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            }, 'image/png', 0.95);
        }).catch(err => console.error('Error rendering image:', err));
    } catch (err) {
        console.error('Error creating image:', err);
        showToast('Failed to create image', 'error');
    }
}

function sendOnWhatsApp(invoice, customerName) {
    const business = currentBusinessName || 'Your Business';
    const custData = customersDataMap[invoice.customerId] || {};
    // Prepare message
    const message = `Hello ${customerName},\n\nHere is your Invoice from *${business}*\n\n*Invoice Number:* ${invoice.invoiceNumber}\n*Amount:* ₹${(invoice.total || 0).toFixed(2)}\n*Due Date:* ${formatDate(invoice.createdAt)}\n\nYou can scan the QR code in the invoice to pay online.\n\nThank you for your business!`.trim();

    const encodedMessage = encodeURIComponent(message);

    // Try to use customer's phone if available (normalize simple numbers)
    let phone = (custData && custData.phone) ? String(custData.phone).replace(/\D/g, '') : '';
    if (phone.length === 10) phone = '91' + phone; // assume India if 10 digits

    const whatsappUrl = phone ? `https://wa.me/${phone}?text=${encodedMessage}` : `https://wa.me/?text=${encodedMessage}`;
    window.open(whatsappUrl, '_blank');
}

// Utils
async function recalculateInvoiceState(invId) {
    console.log(`[TAX ROAD DEBUG] Recalculating invoice state for ${invId}`);

    // 1. get invoice total
    const invRef = doc(db, `users/${currentUser.uid}/invoices`, invId);
    const invDoc = await getDoc(invRef);
    if (!invDoc.exists()) return;

    const invTotal = Number(invDoc.data().total) || 0;

    // 2. sum all receipts for this invoice
    const rQ = query(collection(db, `users/${currentUser.uid}/receipts`), where("invoiceId", "==", invId));
    const rSnaps = await getDocs(rQ);
    let totalPaid = 0;
    rSnaps.forEach(snap => {
        totalPaid += Number(snap.data().amountReceived) || 0;
    });

    // 3. determine status
    let newStatus = 'Pending';
    if (totalPaid > 0) {
        if (Math.abs(invTotal - totalPaid) < 0.01 || totalPaid > invTotal) {
            newStatus = 'Paid';
        } else {
            newStatus = 'Partially Paid';
        }
    }

    // 4. update invoice if changed
    const currentStatus = invDoc.data().status;
    if (currentStatus !== newStatus) {
        await updateDoc(invRef, {
            status: newStatus,
            updatedAt: serverTimestamp()
        });
        console.log(`[TAX ROAD DEBUG] Invoice ${invId} status updated to ${newStatus}`);
    }
}

// Utils
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return typeof unsafe === 'string' ? unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;") : unsafe;
}

// Run init
initInvoices();
